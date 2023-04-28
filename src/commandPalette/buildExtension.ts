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

import * as vscode from "vscode";
import * as path from "path";
import AdmZip = require("adm-zip");
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { sign } from "../utils/cryptography";
import { Dynatrace } from "../dynatrace-api/dynatrace";
import { DynatraceAPIError } from "../dynatrace-api/errors";
import { normalizeExtensionVersion, incrementExtensionVersion } from "../utils/extensionParsing";
import { FastModeStatus } from "../statusBar/fastMode";
import { getExtensionFilePath, resolveRealPath } from "../utils/fileSystem";
import { runCommand } from "../utils/subprocesses";
import { getPythonVenvOpts } from "../utils/otherExtensions";
import { checkDtSdkPresent } from "../utils/conditionCheckers";
import { ExecOptions } from "child_process";

type FastModeOptions = {
  status: FastModeStatus;
  document: vscode.TextDocument;
};

/**
 * Builds an Extension 2.0 and its artefacts into a .zip package ready to upload to Dynatrace.
 * The extension files must all be in an extension folder in the workspace, and developer
 * certificates must be available - either user's own or generated by this extension.
 * If successful, the command is linked to uploading the package to Dynatrace.
 * Note: Only custom extensions may be built/signed using this method.
 * @param context VSCode Extension Context
 * @param oc JSON OutputChannel where detailed errors can be logged
 * @param dt Dynatrace API Client if proper validation is to be done
 * @returns
 */
export async function buildExtension(
  context: vscode.ExtensionContext,
  oc: vscode.OutputChannel,
  dt?: Dynatrace,
  fastMode?: FastModeOptions,
) {
  // Basic details we already know exist
  const workspaceStorage = context.storageUri!.fsPath;
  const workSpaceConfig = vscode.workspace.getConfiguration("dynatrace", null);
  const devCertKey = resolveRealPath(workSpaceConfig.get("developerCertkeyLocation") as string);
  const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const distDir = path.resolve(workspaceRoot, "dist");
  const extensionFile = fastMode ? fastMode.document.fileName : getExtensionFilePath()!;
  const extensionDir = path.resolve(extensionFile, "..");
  // Current name and version
  const extension = readFileSync(extensionFile).toString();
  const extensionName = /^name: "?([:a-zA-Z0-9.\-_]+)"?/gm.exec(extension)![1];
  const currentVersion = normalizeExtensionVersion(/^version: "?([0-9.]+)"?/gm.exec(extension)![1]);

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building extension",
      cancellable: true,
    },
    async (progress, cancelToken) => {
      cancelToken.onCancellationRequested(() => {
        vscode.window.showWarningMessage("Operation cancelled by user.");
      });

      // Handle unsaved changes
      const extensionDocument = vscode.workspace.textDocuments.find(doc =>
        doc.fileName.endsWith("extension.yaml"),
      );
      if (extensionDocument?.isDirty) {
        const saved = await extensionDocument.save();
        if (saved) {
          vscode.window.showInformationMessage("Document saved automatically.");
        } else {
          vscode.window.showErrorMessage(
            "Failed to save extension manifest. Build command cancelled.",
          );
          return;
        }
      }
      if (cancelToken.isCancellationRequested) {
        return;
      }

      // Pre-build workflow
      let updatedVersion = "";
      progress.report({ message: "Checking prerequisites" });
      try {
        updatedVersion = fastMode
          ? await preBuildTasks(
              distDir,
              extensionFile,
              extension,
              extensionName,
              currentVersion,
              true,
              dt,
            )
          : await preBuildTasks(
              distDir,
              extensionFile,
              extension,
              extensionName,
              currentVersion,
              false,
              dt,
            );
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error during pre-build phase: ${err.message}`);
        return;
      } finally {
        if (cancelToken.isCancellationRequested) {
          return;
        }
      }

      // Package assembly workflow
      progress.report({ message: "Building extension package" });
      const zipFilename = `${extensionName.replace(":", "_")}-${updatedVersion}.zip`;
      try {
        if (/^python:$/gm.test(extension)) {
          const envOptions = await getPythonVenvOpts();
          const sdkAvailable = await checkDtSdkPresent(oc, cancelToken, envOptions);
          if (sdkAvailable) {
            await assemblePython(
              workspaceStorage,
              path.resolve(extensionDir, ".."),
              devCertKey,
              envOptions,
              oc,
              cancelToken,
            );
          } else {
            vscode.window.showErrorMessage(
              "Cannot build Python extension - dt-sdk package not available",
            );
            return;
          }
        } else {
          assembleStandard(workspaceStorage, extensionDir, zipFilename, devCertKey);
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error during archiving & signing: ${err.message}`);
        return;
      } finally {
        if (cancelToken.isCancellationRequested) {
          return;
        }
      }

      // Validation & upload workflow
      if (fastMode) {
        progress.report({ message: "Uploading & activating extension" });
        await uploadAndActivate(
          workspaceStorage,
          zipFilename,
          distDir,
          extensionName,
          updatedVersion,
          dt!,
          fastMode.status,
          oc,
          cancelToken,
        );
      } else {
        progress.report({ message: "Validating extension" });
        if (cancelToken.isCancellationRequested) {
          return;
        }
        const valid = await validateExtension(workspaceStorage, zipFilename, distDir, oc, dt);
        if (valid) {
          vscode.window
            .showInformationMessage(
              "Extension built successfully. Would you like to upload it to Dynatrace?",
              "Yes",
              "No",
            )
            .then(choice => {
              if (choice === "Yes") {
                vscode.commands.executeCommand("dt-ext-copilot.uploadExtension");
              }
            });
        }
      }
    },
  );
}

/**
 * Carries out general tasks that should be executed before the build workflow.
 * Ensures the dist folder exists and increments the extension version in case there might
 * be a conflict on the tenant (if dt is provided).
 * @param distDir path to the "dist" directory within the workspace
 * @param extensionFile path to the extension.yaml file
 * @param extensionContent contents of the extension.yaml file
 * @param extensionName the name of the extension
 * @param currentVersion the current version of the extension
 * @param forceIncrement whether to enforce the increment of currentVersion
 * @param dt optional Dynatrace API Client
 */
async function preBuildTasks(
  distDir: string,
  extensionFile: string,
  extensionContent: string,
  extensionName: string,
  currentVersion: string,
  forceIncrement: boolean = false,
  dt?: Dynatrace,
): Promise<string> {
  // Create the dist folder if it doesn't exist
  if (!existsSync(distDir)) {
    mkdirSync(distDir);
  }

  const versionRegex = /^version: ("?[0-9.]+"?)/gm;
  const nextVersion = incrementExtensionVersion(currentVersion);

  if (forceIncrement) {
    // Always increment the version
    writeFileSync(extensionFile, extensionContent.replace(versionRegex, `version: ${nextVersion}`));
    vscode.window.showInformationMessage("Extension version automatically increased.");
    return nextVersion;
  } else if (dt) {
    // Increment the version if there is clash on the tenant
    const versions = await dt.extensionsV2
      .listVersions(extensionName)
      .then(ext => ext.map(e => e.version))
      .catch(() => [] as string[]);
    if (versions.includes(currentVersion)) {
      writeFileSync(
        extensionFile,
        extensionContent.replace(versionRegex, `version: ${nextVersion}`),
      );
      vscode.window.showInformationMessage("Extension version automatically increased.");
      return nextVersion;
    }
  }
  return currentVersion;
}

/**
 * Carries out the archiving and signing parts of the extension build workflow.
 * The intermediary files (inner & outer .zips and signature) are created and stored
 * within the VS Code workspace storage folder to not crowd the user's workspace.
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param extensionDir path to the "extension" folder within the workspace
 * @param zipFileName the name of the .zip file for this build
 * @param devCertKeyPath the path to the developer's fused credential file
 */
function assembleStandard(
  workspaceStorage: string,
  extensionDir: string,
  zipFileName: string,
  devCertKeyPath: string,
) {
  // Build the inner .zip archive
  const innerZip = new AdmZip();
  innerZip.addLocalFolder(extensionDir);
  const innerZipPath = path.resolve(workspaceStorage, "extension.zip");
  innerZip.writeZip(innerZipPath);
  console.log(`Built the inner archive: ${innerZipPath}`);

  // Sign the inner .zip archive and write the signature file
  const signature = sign(innerZipPath, devCertKeyPath);
  const sigatureFilePath = path.resolve(workspaceStorage, "extension.zip.sig");
  writeFileSync(sigatureFilePath, signature);
  console.log(`Wrote the signature file: ${sigatureFilePath}`);

  // Build the outer .zip that includes the inner .zip and the signature file
  const outerZip = new AdmZip();
  const outerZipPath = path.resolve(workspaceStorage, zipFileName);
  outerZip.addLocalFile(innerZipPath);
  outerZip.addLocalFile(sigatureFilePath);
  outerZip.writeZip(outerZipPath);
  console.log(`Wrote initial outer zip at: ${outerZipPath}`);
}

/**
 * Carries out the archiving and signing parts of the extension build workflow.
 * This function is meant for Python extesnions 2.0, therefore all the steps are carried
 * out through `dt-sdk` which must be available on the machine.
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param extensionDir path to the root folder of the workspace
 * @param certKeyPath the path to the developer's fused private key & certificate
 * @param oc JSON output channel for communicating errors
 */
async function assemblePython(
  workspaceStorage: string,
  extensionDir: string,
  certKeyPath: string,
  envOptions: ExecOptions,
  oc: vscode.OutputChannel,
  cancelToken: vscode.CancellationToken,
) {
  // Build
  await runCommand(
    `dt-sdk build -k "${certKeyPath}" "${extensionDir}" -t "${workspaceStorage}" ${
      process.platform === "win32"
        ? "-e linux_x86_64"
        : process.platform === "linux"
        ? "-e win_amd64"
        : "-e linux_x86_64 -e win_amd64"
    }`,
    oc,
    cancelToken,
    envOptions,
  );
}

/**
 * Validates a finalized extension archive against a Dynatrace tenant, if one is connected.
 * Returns true if either the extension passed validation or no API client is connected.
 * Upon success, the final extension archive is moved into the workspace's "dist" folder and
 * removed from the VSCode workspace storage folder (intermediary location).
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param zipFileName the name of the .zip file for this build
 * @param distDir path to the "dist" folder within the workspace
 * @param oc JSON output channel for communicating errors
 * @param dt optional Dynatrace API Client (needed for real validation)
 * @returns validation status
 */
async function validateExtension(
  workspaceStorage: string,
  zipFileName: string,
  distDir: string,
  oc: vscode.OutputChannel,
  dt?: Dynatrace,
) {
  var valid = true;
  const outerZipPath = path.resolve(workspaceStorage, zipFileName);
  const finalZipPath = path.resolve(distDir, zipFileName);
  if (dt) {
    await dt.extensionsV2
      .upload(readFileSync(outerZipPath), true)
      .catch((err: DynatraceAPIError) => {
        vscode.window.showErrorMessage("Extension validation failed.");
        oc.replace(JSON.stringify(err.errorParams.data, null, 2));
        oc.show();
        valid = false;
      });
  }
  // Copy .zip archive into dist dir
  if (valid) {
    copyFileSync(outerZipPath, finalZipPath);
  }
  // Always remove from extension storage
  rmSync(outerZipPath);

  return valid;
}

/**
 * An all-in-one upload & activation flow designed to be used for fast mode builds.
 * If the extension limit has been reached on tenant, either the first or the last version is
 * removed automatically, the extension uploaded, and immediately activated.
 * This skips any prompts compared to regular flow and does not preform any validation.
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param zipFileName the name of the .zip file for this build
 * @param distDir path to the "dist" folder within the workspace
 * @param extensionName name of the extension
 * @param extensionVersion version of the extension
 * @param dt Dynatrace API Client
 * @param status status bar to be updated with build status
 * @param oc JSON output channel for communicating errors
 * @param cancelToken command cancellation token
 */
async function uploadAndActivate(
  workspaceStorage: string,
  zipFileName: string,
  distDir: string,
  extensionName: string,
  extensionVersion: string,
  dt: Dynatrace,
  status: FastModeStatus,
  oc: vscode.OutputChannel,
  cancelToken: vscode.CancellationToken,
) {
  try {
    // Check upload possible
    var existingVersions = await dt.extensionsV2.listVersions(extensionName).catch(err => {
      return [];
    });
    if (existingVersions.length >= 10) {
      // Try delete oldest version
      await dt.extensionsV2
        .deleteVersion(extensionName, existingVersions[0].version)
        .catch(async () => {
          // Try delete newest version
          await dt.extensionsV2.deleteVersion(
            extensionName,
            existingVersions[existingVersions.length - 1].version,
          );
        });
    }

    const file = readFileSync(path.resolve(workspaceStorage, zipFileName));
    // Upload to Dynatrace
    do {
      if (cancelToken.isCancellationRequested) {
        return;
      }
      var lastError;
      var uploadStatus: string = await dt.extensionsV2
        .upload(file)
        .then(() => "success")
        .catch((err: DynatraceAPIError) => {
          lastError = err;
          return err.errorParams.message;
        });
      // Previous version deletion may not be complete yet, loop until done.
      if (uploadStatus.startsWith("Extension versions quantity limit")) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    } while (uploadStatus.startsWith("Extension versions quantity limit"));

    // Activate extension or throw error
    if (uploadStatus === "success") {
      dt.extensionsV2.putEnvironmentConfiguration(extensionName, extensionVersion);
    } else {
      throw lastError;
    }

    // Copy .zip archive into dist dir
    copyFileSync(path.resolve(workspaceStorage, zipFileName), path.resolve(distDir, zipFileName));
    status.updateStatusBar(true, extensionVersion, true);
    oc.clear();
  } catch (err: any) {
    // Mark the status bar as build failing
    status.updateStatusBar(true, extensionVersion, false);
    // Provide details in output channel
    oc.replace(
      JSON.stringify(
        {
          extension: extensionName,
          version: extensionVersion,
          errorDetails: err.errorParams,
        },
        null,
        2,
      ),
    );
    oc.show();
  } finally {
    if (existsSync(path.resolve(workspaceStorage, zipFileName))) {
      rmSync(path.resolve(workspaceStorage, zipFileName));
    }
  }
}
