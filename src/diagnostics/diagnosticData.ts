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

interface ExtensionDiagnostic {
  code: string | number | { value: string | number; target: vscode.Uri } | undefined;
  severity: vscode.DiagnosticSeverity;
  message: string;
}

/**
 * Creates a {@link vscode.Diagnostic} from a known Extension Diagnostic
 * @param startPos VSCode Position marking the start of the highlight
 * @param endPos VSCode Position marking the end of the highlight
 * @param diagnostic one of the known Extension Diagnostics (defined below)
 * @returns VSCode Diagnostic
 */
export function extensionDiagnostic(
  startPos: vscode.Position,
  endPos: vscode.Position,
  diagnostic: ExtensionDiagnostic,
): vscode.Diagnostic {
  return {
    range: new vscode.Range(startPos, endPos),
    message: diagnostic.message,
    code: diagnostic.code,
    severity: diagnostic.severity,
    source: "Dynatrace Extensions",
  };
}

/**
 * ALL KNOWN DYNATRACE EXTENSIONS COPILOT DIAGNOSTICS SHOULD BE CATALOGUED HERE
 * ============================================================================
 * This allows later re-use of the known codes for other features like Quick
 * Fix actions and condition checkers. The code you use when adding a new
 * diagnostic to the catalogue does not indicate anything - it just needs to
 * be unique. "DED" was used to indicate Dynatrace Extensions Diagnostic.
 */

export const EXTENSION_NAME_MISSING: ExtensionDiagnostic = {
  code: "DED001",
  severity: vscode.DiagnosticSeverity.Error,
  message: "Extension name is mandatory, but missing.",
};

export const EXTENSION_NAME_TOO_LONG: ExtensionDiagnostic = {
  code: "DED002",
  severity: vscode.DiagnosticSeverity.Error,
  message: "Extension name must not be longer than 50 characters.",
};

export const EXTENSION_NAME_INVALID: ExtensionDiagnostic = {
  code: "DED003",
  severity: vscode.DiagnosticSeverity.Error,
  message:
    "Extension name is invalid. " +
    "Must only contain lowercase letters, numbers, hyphens, underscores, or dots.",
};

export const EXTENSION_NAME_NON_CUSTOM: ExtensionDiagnostic = {
  code: "DED004",
  severity: vscode.DiagnosticSeverity.Error,
  message: 'Only custom extensions can be built (name must start with "custom:")',
};

export const EXTENSION_NAME_CUSTOM_ON_BITBUCKET: ExtensionDiagnostic = {
  code: "DED005",
  severity: vscode.DiagnosticSeverity.Warning,
  message: "BitBucket-linked extensions should not have custom names",
};

export const COUNT_METRIC_KEY_SUFFIX: ExtensionDiagnostic = {
  code: "DED006",
  severity: vscode.DiagnosticSeverity.Warning,
  message: 'Metrics of type count should have keys ending in ".count" or "_count"',
};

export const GAUGE_METRIC_KEY_SUFFIX: ExtensionDiagnostic = {
  code: "DED007",
  severity: vscode.DiagnosticSeverity.Warning,
  message: 'Metrics of type gauge should not have keys ending in ".count" or "_count"',
};

export const REFERENCED_CARD_NOT_DEFINED: ExtensionDiagnostic = {
  code: "DED008",
  severity: vscode.DiagnosticSeverity.Error,
  message: "This card is referenced in layout but does not have a definition within this screen",
};

export const DEFINED_CARD_NOT_REFERENCED: ExtensionDiagnostic = {
  code: "DED009",
  severity: vscode.DiagnosticSeverity.Warning,
  message: "This card is defined but is not referenced within the screen layout",
};

export const OID_DOES_NOT_EXIST: ExtensionDiagnostic = {
  code: "DED010",
  severity: vscode.DiagnosticSeverity.Warning,
  message: "The existence of this OID could not be verified.",
};

export const OID_NOT_READABLE: ExtensionDiagnostic = {
  code: "DED011",
  severity: vscode.DiagnosticSeverity.Error,
  message: "This OID is not readable (MAX-ACCESS does not allow reading).",
};

export const OID_STRING_AS_METRIC: ExtensionDiagnostic = {
  code: "DED012",
  severity: vscode.DiagnosticSeverity.Error,
  message: "This OID returns a string but it's being used as a numerical metric value.",
};

export const OID_COUNTER_AS_GAUGE: ExtensionDiagnostic = {
  code: "DED013",
  severity: vscode.DiagnosticSeverity.Warning,
  message: "This OID returns a Counter but is being used as a Gauge metric.",
};

export const OID_GAUGE_AS_COUNTER: ExtensionDiagnostic = {
  code: "DED014",
  severity: vscode.DiagnosticSeverity.Warning,
  message: "This OID returns a Gauge but is being used as a Counter metric.",
};

export const OID_SYNTAX_INVALID: ExtensionDiagnostic = {
  code: "DED015",
  severity: vscode.DiagnosticSeverity.Error,
  message:
    "Invalid OID syntax. OID must not start/end with '.' and may only contain dots and digits.",
};

export const OID_DOT_ZERO_IN_TABLE: ExtensionDiagnostic = {
  code: "DED016",
  severity: vscode.DiagnosticSeverity.Error,
  message: "Invalid OID syntax. OIDs must not end in '.0' when part of a 'table' subgroup.",
};

export const OID_DOT_ZERO_MISSING: ExtensionDiagnostic = {
  code: "DED017",
  severity: vscode.DiagnosticSeverity.Error,
  message:
    "Invalid OID syntax. OIDs must end in '.0' when they are not part of a 'table' subgroup.",
};

export const OID_STATIC_OBJ_IN_TABLE: ExtensionDiagnostic = {
  code: "DED018",
  severity: vscode.DiagnosticSeverity.Error,
  message: "Type conflict. This OID is static but being used inside a 'table' subgroup.",
};

export const OID_TABLE_OBJ_AS_STATIC: ExtensionDiagnostic = {
  code: "DED019",
  severity: vscode.DiagnosticSeverity.Error,
  message:
    "Type conflict. " +
    "This OID maps to table entries but is not being used inside a 'table' subgroup.",
};
