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
import { ExtensionStub } from "../interfaces/extensionMeta";
import { CachedDataConsumer } from "../utils/dataCaching";

import {
  getAllMetricKeysAndValuesFromDataSource,
  getJMXLabelKeys,
  getJMXMetricKeys,
} from "../utils/extensionParsing";
import { getBlockItemIndexAtLine, getParentBlocks } from "../utils/yamlParsing";
import { buildMetricMetadataSnippet, indentJMXSnippet } from "./utils/snippetBuildingUtils";

/**
 * Provider for Code Actions that work with scraped JMX data to automatically
 * insert it in the Extension yaml.
 */
export class JMXActionProvider extends CachedDataConsumer implements vscode.CodeActionProvider {
  /**
   * Provides the Code Actions that insert details based on JMX scraped data.
   * @param document document that activated the provider
   * @param range range that activated the provider
   * @param context Code Action context
   * @param token cancellation token
   * @returns list of Code Actions
   */
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
  ): vscode.CodeAction[] {
    const codeActions: vscode.CodeAction[] = [];

    // Bail early if different datasource or no scraped data
    if (!/^jmx:/gm.test(document.getText()) || this.jmxData.length === 0) {
      console.log("HERE");
      return [];
    }

    console.log("THERE");
    const lineText = document.lineAt(range.start.line).text;
    const parentBlocks = getParentBlocks(range.start.line, document.getText());

    // Metrics and dimensions
    if (
      parentBlocks[parentBlocks.length - 1] === "jmx" ||
      parentBlocks[parentBlocks.length - 1] === "subgroups"
    ) {
      if (lineText.includes("metrics:")) {
        console.log("EVERYWHERE");
        codeActions.push(...this.createMetricInsertions(document, range));
      }
    }
    return codeActions;
  }

  /**
   * Creates a Code Action that inserts a snippet of text on the next line at index 0.
   * @param actionName name of the Code Action
   * @param textToInsert the snippet to insert
   * @param document the document that triggered the action
   * @param range the range that triggered the action
   * @returns Code Action
   */
  private createInsertAction(
    actionName: string,
    textToInsert: string,
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.CodeAction | undefined {
    if (document.lineCount === range.start.line + 1) {
      textToInsert = "\n" + textToInsert;
    }
    const firstLineMatch = /[a-z]/i.exec(document.lineAt(range.start.line).text);
    if (firstLineMatch) {
      const indent = firstLineMatch.index;
      const insertPosition = new vscode.Position(range.start.line + 1, 0);
      const action = new vscode.CodeAction(actionName, vscode.CodeActionKind.QuickFix);
      action.edit = new vscode.WorkspaceEdit();
      action.edit.insert(document.uri, insertPosition, indentJMXSnippet(textToInsert, indent));
      return action;
    }
  }

  /**
   * Creates Code Actions for inserting metrics from scraped JMX data.
   * Actions are created for individual metrics as well as all-in-one.
   * @param document the document that triggered the action provider
   * @param range the range that triggered the action
   * @param existingKeys keys that have already been inserted in yaml (to be excluded)
   * @returns list of code actions
   */
  private createMetricInsertions(
    document: vscode.TextDocument,
    range: vscode.Range,
  ): vscode.CodeAction[] {
    const codeActions: vscode.CodeAction[] = [];

    // Insert all metrics in one go
    const action = this.createInsertAction(
      "Insert JMX Response",
      String(this.jmxData[this.jmxData.length - 1]),
      document,
      range,
    );
    if (action) {
      codeActions.push(action);
    }
    return codeActions;
  }
}
