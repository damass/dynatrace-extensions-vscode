/**
  Copyright 2022 Dynatrace LLC

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
 */

/********************************************************************************
 * UTILITIES FOR CHECKING CONDITIONS AND RETURNING A SIMPLE STATUS OF THE CHECK
 ********************************************************************************/

import { ExecOptions } from "child_process";
import { existsSync, readdirSync, readFileSync } from "fs";
import * as path from "path";
import axios from "axios";
import * as vscode from "vscode";
import { EnvironmentsTreeDataProvider } from "../treeViews/environmentsTreeView";
import { showMessage } from "./code";
import { getExtensionFilePath, resolveRealPath } from "./fileSystem";
import { runCommand } from "./subprocesses";

/**
 * Checks whether one or more VSCode settings are configured.
 * Does not differentiate whether the setting has been set at global or workspace level.
 * @param settings VSCode settings IDs
 * @returns check status
 */
export async function checkSettings(...settings: string[]): Promise<boolean> {
  const config = vscode.workspace.getConfiguration("dynatraceExtensions", null);
  let status = true;
  for (const setting of settings) {
    if (!config.get(setting)) {
      console.log(`Setting ${setting} not found. Check failed.`);
      await vscode.window
        .showErrorMessage(
          `Missing one or more required settings. Check ${setting}`,
          "Open settings",
        )
        .then(async opt => {
          if (opt === "Open settings") {
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "@ext:DynatracePlatformExtensions.dynatrace-extensions",
            );
          }
        });
      status = false;
      break;
    }
  }

  console.log(`Check - are required settings present? > ${String(status)}`);
  return status;
}

/**
 * Checks whether a Dynatrace Environment is selected for use.
 * @param environmentsTree environments tree data provider
 * @returns check status
 */
export async function checkEnvironmentConnected(
  environmentsTree: EnvironmentsTreeDataProvider,
): Promise<boolean> {
  let status = true;
  if (!(await environmentsTree.getCurrentEnvironment())) {
    showMessage("error", "You must be connected to a Dynatrace Environment to use this command.");
    status = false;
  }

  console.log(`Check - is an environment connected? > ${String(status)}`);
  return status;
}

/**
 * Checks whether a workspace is open within the current window or not.
 * @param suppressMessaging if false, a message notification will be displayed to the user
 * @returns check status
 */
export async function checkWorkspaceOpen(suppressMessaging: boolean = false): Promise<boolean> {
  let status = true;
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    if (!suppressMessaging) {
      await vscode.window
        .showErrorMessage("You must be inside a workspace to use this command.", "Open folder")
        .then(async opt => {
          if (opt === "Open folder") {
            await vscode.commands.executeCommand("vscode.openFolder");
          }
        });
    }
    status = false;
  }
  console.log(`Check - is a workspace open? > ${String(status)}`);
  return status;
}

/**
 * Checks whether the currently opened workspace is an Extensions 2.0 workspace or not.
 * @param context VSCode Extension Context
 * @param showWarningMessage when true, displays a warning message to the user
 * @returns check status
 */
export async function isExtensionsWorkspace(
  context: vscode.ExtensionContext,
  showWarningMessage: boolean = true,
): Promise<boolean> {
  let status = false;
  if (context.storageUri && existsSync(context.storageUri.fsPath)) {
    const extensionYaml = getExtensionFilePath();
    if (!extensionYaml) {
      if (showWarningMessage) {
        showMessage(
          "warn",
          "This command must be run from an Extensions Workspace. " +
            "Ensure your `extension` folder is within the root of the workspace.",
        );
      }
    } else {
      status = true;
    }
  }

  console.log(`Check - is this an extensions workspace? > ${String(status)}`);
  return status;
}

/**
 * Checks whether the workspace storage already has certificate files and prompts for overwriting.
 * Assumes the workspace storage has already been setup (i.e. path exists).
 * @param context
 * @returns true if operation should continue, false for cancellation
 */
export async function checkOverwriteCertificates(
  context: vscode.ExtensionContext,
): Promise<boolean> {
  let status = true;
  const storageUri = context.storageUri?.fsPath;
  if (!storageUri) {
    return false;
  }
  const certsDir = path.join(storageUri, "certificates");
  if (existsSync(certsDir)) {
    if (existsSync(path.join(certsDir, "dev.pem")) || existsSync(path.join(certsDir, "ca.pem"))) {
      const choice = await vscode.window.showQuickPick(["Yes", "No"], {
        canPickMany: false,
        title: "Workspace already has certificates.",
        placeHolder: "Would you like to generate new ones?",
        ignoreFocusOut: true,
      });
      if (!choice || choice === "No") {
        status = false;
      }
    }
  }
  console.log(`Check - can continue and/or overwrite certificates? > ${String(status)}`);
  return status;
}

/**
 * Checks whether the workspace has certificates associated with it.
 * Assumes the workspace storage has already been setup (i.e. path exists).
 * @param type type of certificates to check for
 * @param context VSCode Extension Context
 * @returns status of check
 */
export async function checkCertificateExists(type: "ca" | "dev" | "all"): Promise<boolean> {
  let allExist = true;
  const devCertkeyPath = vscode.workspace
    .getConfiguration("dynatraceExtensions", null)
    .get<string>("developerCertkeyLocation");
  const caCertPath = vscode.workspace
    .getConfiguration("dynatraceExtensions", null)
    .get<string>("rootOrCaCertificateLocation");

  if (type === "ca" || type === "all") {
    if (!caCertPath) {
      allExist = false;
    } else if (!existsSync(resolveRealPath(caCertPath))) {
      allExist = false;
    }
  }
  if (type === "dev" || type === "all") {
    if (!devCertkeyPath) {
      allExist = false;
    } else if (!existsSync(resolveRealPath(devCertkeyPath))) {
      allExist = false;
    }
  }
  console.log(`Check - ${type.toUpperCase()} certificates exist? > ${String(allExist)}`);

  if (!allExist) {
    await vscode.window
      .showErrorMessage(
        "Workspace does not have the required certificates associated with it.",
        "Generate new ones",
        "Open settings",
      )
      .then(async opt => {
        switch (opt) {
          case "Generate new ones":
            await vscode.commands.executeCommand("dynatrace-extensions.generateCertificates");
            break;
          case "Open settings":
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "Dynatrace Location",
            );
            break;
        }
      });
  }
  return allExist;
}

/**
 * Checks whether the `dist` folder is found in the root of the workspace and
 * whether it has any .zip archives within its contents.
 * @returns status of check
 */
export async function checkExtensionZipExists(): Promise<boolean> {
  if (vscode.workspace.workspaceFolders) {
    const distDir = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, "dist");
    if (readdirSync(distDir).filter(i => i.endsWith(".zip")).length === 0) {
      showMessage("error", "No extension archive was found. Try building one first.");
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Checks whether a URL returns a 200 response code.
 * @param url the URL to check
 * @param showError whether to print the error received or just supress it
 * @returns status of check
 */
export async function checkUrlReachable(url: string, showError: boolean = false): Promise<boolean> {
  const status = await axios
    .get(url)
    .then(res => res.status === 200)
    .catch(err => {
      if (showError) {
        showMessage("error", (err as Error).message);
      }
      console.log(JSON.stringify(err));
      return false;
    });

  console.log(`Check - is URL ${url} reachable? > ${String(status)}`);

  return status;
}

/**
 * Checks whether either gradle.properties (all other extensions) or Jenkinsfile (python extensions)
 * exists and the details map back to the Dynatrace Artifactory server.
 * @returns status of check
 */
export async function checkDtInternalProperties(): Promise<boolean> {
  let status = false;
  // Must have gradle.properties file or Jenkinsfile (for python)
  let hasGradleProps = false;
  let hasJenkinsProps = false;

  // Check if we have gradle.properties first
  let files = await vscode.workspace.findFiles("**/gradle.properties");
  if (files.length === 0) {
    // Check if we have Jenkinsfile instead
    files = await vscode.workspace.findFiles("**Jenkinsfile");
    if (files.length > 0) {
      hasJenkinsProps = true;
    }
  } else {
    hasGradleProps = true;
  }
  // Gradle properties must have our repositoryBaseURL and releaseRepository
  if (hasGradleProps) {
    const props = readFileSync(files[0].fsPath).toString();
    const baseUrlMatches = /repositoryBaseURL=(.*)/.exec(props);
    const repoMatches = /releaseRepository=(.*)/.exec(props);
    if (
      baseUrlMatches &&
      repoMatches &&
      baseUrlMatches[1] === "https://artifactory.lab.dynatrace.org/artifactory" &&
      repoMatches[1] === "extensions-release"
    ) {
      status = true;
    }
  }
  // Jenkins properties must have our rtServer details
  if (hasJenkinsProps) {
    const props = readFileSync(files[0].fsPath).toString();
    const rtServerId = /id: '(.*?)'/.exec(props);
    const rtUrl = /url: "(.*?)"/.exec(props);
    if (
      rtServerId &&
      rtUrl &&
      rtServerId[1] === "EXTENSION_ARTIFACTORY_SERVER" &&
      rtUrl[1] === "https://artifactory.lab.dynatrace.org/artifactory"
    ) {
      status = true;
    }
  }

  console.log(`Check - is this an internal Dynatrace repo? > ${String(status)}`);

  return status;
}

/**
 * Checks whether the OneAgent is installed on the local machine.
 * Note - it is a shallow check, dependent only on installation directory existence!
 * @returns status of check
 */
export function checkOneAgentInstalled(): boolean {
  const oaWinPath = "C:\\ProgramData\\dynatrace\\oneagent\\agent\\config";
  const oaLinPath = "/var/lib/dynatrace/oneagent/agent/config";
  const status = process.platform === "win32" ? existsSync(oaWinPath) : existsSync(oaLinPath);

  console.log(`Check - is OneAgent installed locally? > ${String(status)}`);
  return status;
}

/**
 * Checks whether the ActiveGate is installed on the local machine.
 * Note - it is a shallow check, dependent only on installation directory existence!
 * @returns status of check
 */
export function checkActiveGateInstalled(): boolean {
  const agWinPath = "C:\\ProgramData\\dynatrace\\remotepluginmodule\\agent\\conf";
  const agLinPath = "/var/lib/dynatrace/remotepluginmodule/agent/conf";
  const status = process.platform === "win32" ? existsSync(agWinPath) : existsSync(agLinPath);

  console.log(`Check - is ActiveGate installed locally? > ${String(status)}`);
  return status;
}

/**
 * Checks whether the DT-SDK is installed on the Python environment.
 * Doesn't care so much about reasoning, just provides the status of the check.
 * @param oc: {@link vscode.OutputChannel}
 * @param cancelToken: {@link vscode.CancellationToken}
 * @param envOptions: {@link ExecOptions}
 * @returns status of check
 */
export async function checkDtSdkPresent(
  oc?: vscode.OutputChannel,
  cancelToken?: vscode.CancellationToken,
  envOptions?: ExecOptions,
): Promise<boolean> {
  const status = await runCommand("dt-sdk --help", oc, cancelToken, envOptions)
    .then(() => true)
    .catch(() => false);

  console.log(`Check - Is dt-sdk available? > ${String(status)}`);

  return status;
}
