import * as vscode from "vscode";
import * as path from "path";
import * as yaml from "yaml";
import AdmZip = require("adm-zip");
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { sign } from "../utils/cryptography";
import { Dynatrace } from "../dynatrace-api/dynatrace";
import { DynatraceAPIError } from "../dynatrace-api/errors";
import { normalizeExtensionVersion, incrementExtensionVersion, getDatasourceName } from "../utils/extensionParsing";
import { FastModeStatus } from "../statusBar/fastMode";
import { exec } from "child_process";

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
  fastMode?: FastModeOptions
) {
  // Basic details we already know exist
  const workspaceStorage = context.storageUri!.fsPath;
  const workSpaceConfig = vscode.workspace.getConfiguration("dynatrace", null);
  const devKey = workSpaceConfig.get("developerKeyLocation") as string;
  const devCert = workSpaceConfig.get("developerCertificateLocation") as string;
  const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const distDir = path.resolve(workspaceRoot, "dist");
  const extensionFile = fastMode
    ? fastMode.document.fileName
    : await vscode.workspace.findFiles("**/extension/extension.yaml").then((files) => files[0].fsPath);
  const extensionDir = path.resolve(extensionFile, "..");

  // Pre-build workflow
  var success = fastMode
    ? await preBuildTasks(distDir, extensionFile, true, dt)
    : await preBuildTasks(distDir, extensionFile, false, dt);
  const extension = yaml.parse(readFileSync(extensionFile).toString());
  const zipFilename = `${extension.name.replace(":", "_")}-${extension.version}.zip`;
  if (!success) return;

  // Package assembly workflow
  success =
    getDatasourceName(extension) === "python"
      ? await assemblePython(workspaceStorage, workspaceRoot, zipFilename, devKey, devCert, oc)
      : await assembleStandard(workspaceStorage, extensionDir, zipFilename, devKey, devCert);
  if (!success) return;

  // Validation & upload workflow
  if (fastMode) {
    uploadAndActivate(path.resolve(distDir, zipFilename), extension, dt!, fastMode.status, oc);
  } else {
    const valid = await validateExtension(workspaceStorage, zipFilename, distDir, oc, dt);
    if (valid) {
      vscode.window
        .showInformationMessage("Extension built successfully. Would you like to upload it to Dynatrace?", "Yes", "No")
        .then((choice) => {
          if (choice === "Yes") {
            vscode.commands.executeCommand("dt-ext-copilot.uploadExtension");
          }
        });
    }
  }
}

/**
 * Carries out general tasks that should be executed before the build workflow.
 * Ensures the dist folder exists and increments the extension version in case there might
 * be a conflict on the tenant (if dt is provided).
 * @param distDir path to the "dist" directory within the workspace
 * @param extensionFile path to the extension.yaml file within the workspace
 * @param dt optional Dynatrace API Client
 * @returns success status
 */
async function preBuildTasks(
  distDir: string,
  extensionFile: string,
  forceIncrement: boolean = false,
  dt?: Dynatrace
): Promise<Boolean> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building Extension",
    },
    async (progress) => {
      progress.report({ message: "Checking the dist folder" });
      // Create the dist folder if it doesn't exist
      if (!existsSync(distDir)) {
        mkdirSync(distDir);
      }

      try {
        if (forceIncrement) {
          // Always increment the version
          const extension = yaml.parse(readFileSync(extensionFile).toString());
          const extensionVersion = normalizeExtensionVersion(extension.version);
          extension.version = incrementExtensionVersion(extensionVersion);
          writeFileSync(extensionFile, yaml.stringify(extension, { lineWidth: 0 }));
          vscode.window.showInformationMessage("Extension version automatically increased.");
        } else if (dt) {
          // Increment the version if there is clash on the tenant
          const extension = yaml.parse(readFileSync(extensionFile).toString());
          const extensionVersion = normalizeExtensionVersion(extension.version);
          progress.report({ message: "Checking version conflicts for extension" });
          const versions = await dt.extensionsV2
            .listVersions(extension.name)
            .then((ext) => ext.map((e) => e.version))
            .catch(() => [] as string[]);
          if (versions.includes(extensionVersion)) {
            extension.version = incrementExtensionVersion(extensionVersion);
            writeFileSync(extensionFile, yaml.stringify(extension, { lineWidth: 0 }));
            vscode.window.showInformationMessage("Extension version automatically increased.");
          }
        }
        return true;
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error during pre-build phase: ${err.message}`);
        return false;
      }
    }
  );
}

/**
 * Carries out the archiving and signing parts of the extension build workflow.
 * The intermediary files (inner & outer .zips and signature) are created and stored
 * within the VS Code workspace storage folder to not crowd the user's workspace.
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param extensionDir path to the "extension" folder within the workspace
 * @param zipFileName the name of the .zip file for this build
 * @param devKeyPath the path to the developer's private key
 * @param devCertPath the path to the developer's certificate
 * @returns success status
 */
async function assembleStandard(
  workspaceStorage: string,
  extensionDir: string,
  zipFileName: string,
  devKeyPath: string,
  devCertPath: string
): Promise<Boolean> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building extension",
    },
    async (progress) => {
      try {
        // Build the inner .zip archive
        progress.report({ message: "Building the .zip archive" });
        const innerZip = new AdmZip();
        innerZip.addLocalFolder(extensionDir);
        const innerZipPath = path.resolve(workspaceStorage, "extension.zip");
        innerZip.writeZip(innerZipPath);
        console.log(`Built the inner archive: ${innerZipPath}`);

        // Sign the inner .zip archive and write the signature file
        progress.report({ message: "Signing the .zip archive" });
        const signature = sign(innerZipPath, devKeyPath, devCertPath);
        const sigatureFilePath = path.resolve(workspaceStorage, "extension.zip.sig");
        writeFileSync(sigatureFilePath, signature);
        console.log(`Wrote the signature file: ${sigatureFilePath}`);

        // Build the outer .zip that includes the inner .zip and the signature file
        progress.report({ message: "Building the final package" });
        const outerZip = new AdmZip();
        const outerZipPath = path.resolve(workspaceStorage, zipFileName);
        outerZip.addLocalFile(innerZipPath);
        outerZip.addLocalFile(sigatureFilePath);
        outerZip.writeZip(outerZipPath);
        console.log(`Wrote initial outer zip at: ${outerZipPath}`);
        return true;
      } catch (err: any) {
        vscode.window.showErrorMessage(`Error during arhiving & signing: ${err.message}`);
        return false;
      }
    }
  );
}

/**
 * Executes the given command in a child process and wraps the whole thing in a Promise.
 * This way the execution is async but other code can await it.
 * On success, returns the exit code (if any). Will throw any error with the contents
 * of stderr.
 * @param command the command to execute
 * @returns exit code or `null`
 */
function runCommand(command: string): Promise<number | null> {
  let p = exec(command);
  let [stdout, stderr] = ["", ""];
  return new Promise((resolve, reject) => {
    p.stdout?.on("data", (data) => (stdout += data.toString()));
    p.stderr?.on("data", (data) => (stderr += data.toString()));
    p.on("exit", (code) => {
      if (code !== 0) {
        console.log(stderr);
        reject(Error(stderr));
      }
      console.log(stdout);
      return resolve(code);
    });
  });
}

/**
 * Carries out the archiving and signing parts of the extension build workflow.
 * This function is meant for Python extesnions 2.0, therefore all the steps are carried
 * out through `dt-sdk` which must be available on the machine.
 * @param workspaceStorage path to the VS Code folder for this workspace's storage
 * @param extensionDir path to the "extension" folder within the workspace
 * @param zipFileName the name of the .zip file for this build
 * @param devKeyPath the path to the developer's private key
 * @param devCertPath the path to the developer's certificate
 * @param oc JSON output channel for communicating errors
 * @returns success status
 */
async function assemblePython(
  workspaceStorage: string,
  extensionDir: string,
  zipFileName: string,
  devKeyPath: string,
  devCertPath: string,
  oc: vscode.OutputChannel
): Promise<Boolean> {
  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building extension",
    },
    async (progress) => {
      try {
        // Check we can run dt-sdk
        progress.report({ message: "Checking dt-sdk is usable" });
        await runCommand("dt-sdk --help");

        // Download dependencies
        progress.report({ message: "Downloading dependencies" });
        await runCommand(`dt-sdk wheel "${extensionDir}"`);

        // Build the inner .zip archive
        progress.report({ message: "Building the .zip archive" });
        await runCommand(`dt-sdk assemble -o "${workspaceStorage}" "${extensionDir}"`);

        // Sign the inner .zip archive and write the signature file
        progress.report({ message: "Signing the .zip archive" });
        const innerZip = path.resolve(workspaceStorage, "extension.zip");
        const outerZip = path.resolve(workspaceStorage, zipFileName);
        await runCommand(`dt-sdk sign -o "${outerZip}" -k "${devKeyPath}" -c "${devCertPath}" "${innerZip}"`);

        return true;
      } catch (err: any) {
        const [shortMessage, ...details] = err.message.substring(err.message.indexOf("ERROR") + 7).split("+");
        vscode.window.showErrorMessage(`Error during archiving & signing: ${shortMessage}`);
        oc.replace(
          JSON.stringify(
            { error: shortMessage.split("\r\n"), detailedOutput: `+${details.join("+")}`.split("\r\n") },
            null,
            2
          )
        );
        oc.show();
        return false;
      }
    }
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
function validateExtension(
  workspaceStorage: string,
  zipFileName: string,
  distDir: string,
  oc: vscode.OutputChannel,
  dt?: Dynatrace
) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building extension",
    },
    async (progress) => {
      var valid = true;
      const outerZipPath = path.resolve(workspaceStorage, zipFileName);
      const finalZipPath = path.resolve(distDir, zipFileName);
      if (dt) {
        progress.report({ message: "Validating the final package contents" });
        await dt.extensionsV2.upload(readFileSync(outerZipPath), true).catch((err: DynatraceAPIError) => {
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
  );
}

/**
 * An all-in-one upload & activation flow designed to be used for fast mode builds.
 * If the extension limit has been reached on tenant, either the first or the last version is
 * removed automatically, the extension uploaded, and immediately activated.
 * This skips any prompts compared to regular flow and does not preform any validation.
 * @param extensionFile path to the extension file within the workspace
 * @param extension extension.yaml serialized as object
 * @param dt Dynatrace API Client
 * @param status status bar to be updated with build status
 * @param oc JSON output channel for communicating errors
 */
async function uploadAndActivate(
  extensionFile: string,
  extension: ExtensionStub,
  dt: Dynatrace,
  status: FastModeStatus,
  oc: vscode.OutputChannel
) {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Building extension",
    },
    async (progress) => {
      try {
        // Check upload possible
        progress.report({ message: "Uploading to Dynatrace" });
        var existingVersions = await dt.extensionsV2.listVersions(extension.name).catch((err) => {
          return [];
        });
        if (existingVersions.length >= 10) {
          // Try delete oldest version
          await dt.extensionsV2.deleteVersion(extension.name, existingVersions[0].version).catch(async () => {
            // Try delete newest version
            await dt.extensionsV2.deleteVersion(extension.name, existingVersions[existingVersions.length - 1].version);
          });
        }
        // Upload to Dynatrace & activate version
        await dt.extensionsV2.upload(readFileSync(extensionFile)).then(() => {
          progress.report({ message: "Activating extension" });
          dt.extensionsV2.putEnvironmentConfiguration(extension.name, extension.version);
        });
        status.updateStatusBar(true, extension.version, true);
        oc.clear();
      } catch (err: any) {
        // Mark the status bar as build failing
        status.updateStatusBar(true, extension.version, false);
        // Provide details in output channel
        oc.replace(
          JSON.stringify(
            {
              extension: extension.name,
              version: extension.version,
              errorDetails: err.errorParams,
            },
            null,
            2
          )
        );
        oc.show();
      }
    }
  );
}
