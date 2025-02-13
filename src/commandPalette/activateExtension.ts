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
import { Dynatrace } from "../dynatrace-api/dynatrace";
import { DynatraceAPIError } from "../dynatrace-api/errors";
import { ExtensionStub } from "../interfaces/extensionMeta";
import { showMessage } from "../utils/code";
import { CachedData } from "../utils/dataCaching";
import { getExtensionFilePath } from "../utils/fileSystem";

/**
 * Activates the extension found in the currently open workspace. If a version is not provided
 * already, the user is prompted for selection from the versions found on the tenant.
 * @param dt Dynatrace API Client
 * @param cachedData provider for cacheable data
 * @param version optional version to activate
 */
export async function activateExtension(
  dt: Dynatrace,
  cachedData: CachedData,
  tenantUrl: string,
  version?: string,
) {
  const extensionFile = getExtensionFilePath();
  if (!extensionFile) {
    return;
  }

  const extension = cachedData.getCached<ExtensionStub>("parsedExtension");

  // If version was not provided, prompt user for selection
  if (!version) {
    version = await vscode.window.showQuickPick(
      dt.extensionsV2.listVersions(extension.name).then(res => res.map(me => me.version)),
      {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Activate extension",
        placeHolder: "Choose a version to activate",
      },
    );
  }

  // Activate the given version of the extension
  if (version) {
    dt.extensionsV2
      .putEnvironmentConfiguration(extension.name, version)
      .then(() => vscode.window.showInformationMessage("Extension activated successfully.", "Open"))
      .then(open => {
        if (open === "Open") {
          const baseUrl = tenantUrl.includes(".apps")
            ? `${tenantUrl}/ui/apps/dynatrace.classic.extensions`
            : tenantUrl;

          return vscode.env.openExternal(
            vscode.Uri.parse(`${baseUrl}/ui/hub/ext/${extension.name}`),
          );
        }
      })
      .catch((err: DynatraceAPIError) => {
        showMessage("error", err.message);
      });
  } else {
    showMessage("error", "Version not selected. Cancelling operation.");
  }
}
