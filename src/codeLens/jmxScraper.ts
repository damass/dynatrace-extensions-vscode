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

import axios from "axios";
import * as vscode from "vscode";
import { showMessage } from "../utils/code";
import { CachedData, CachedDataProducer } from "../utils/dataCaching";

export type JMXData = Record<string, JMXDetails>;
type JMXDetails = {
  type?: string;
  dimensions?: string[];
  description?: string;
};
type JMXAuth = "No authentication" | "Bearer token" | "Username & password" | "AWS key";
type ScrapingMethod = "Endpoint" | "File";

/**
 * Code Lens Provider implementation to facilitate loading JMX metrics and data
 * from an external endpoint and leveraging it in other parts of the extension.
 */
export class JMXCodeLensProvider extends CachedDataProducer implements vscode.CodeLensProvider {
  private codeLenses: vscode.CodeLens[];
  private regex: RegExp;
  private lastScrape = "N/A";
  private method: ScrapingMethod | undefined;
  private jmxUrl: string | undefined;
  private jmxAuth: JMXAuth | undefined;
  private jmxToken: string | undefined;
  private jmxUsername: string | undefined;
  private jmxPassword: string | undefined;
  private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;

  /**
   * @param cachedDataProvider provider of cacheable data
   */
  constructor(cachedData: CachedData) {
    super(cachedData);
    this.codeLenses = [];
    this.regex = /^(jmx:)/gm;
    vscode.commands.registerCommand(
      "dynatrace-extensions.codelens.scrapeJMXMetrics",
      async (changeConfig: boolean) => {
        await this.scrapeJMXMetrics(changeConfig);
      },
    );
  }

  /**
   * Provides the actual Code Lenses. Two lenses are created: one to allow endpoint
   * detail collection and reading/processing data, the other to show when data was
   * last read and processed.
   * @param document document where provider was invoked
   * @param token cancellation token
   * @returns list of Code Lenses
   */
  public provideCodeLenses(
    document: vscode.TextDocument,
  ): vscode.ProviderResult<vscode.CodeLens[]> {
    this.codeLenses = [];
    const regex = new RegExp(this.regex);
    const text = document.getText();

    let matches;
    while ((matches = regex.exec(text)) !== null) {
      const line = document.lineAt(document.positionAt(matches.index).line);
      const indexOf = line.text.indexOf(matches[0]);
      const position = new vscode.Position(line.lineNumber, indexOf);
      const range = document.getWordRangeAtPosition(position, new RegExp(this.regex));

      if (range) {
        // Action lens
        this.codeLenses.push(
          new vscode.CodeLens(range, {
            title: "Scrape data",
            tooltip:
              "Connect to an exporter or read a file and scrape metrics, then use them in the Extension.",
            command: "dynatrace-extensions.codelens.scrapeJMXMetrics",
            arguments: [],
          }),
        );
        // Edit config lens
        if (this.lastScrape !== "N/A") {
          this.codeLenses.push(
            new vscode.CodeLens(range, {
              title: "Edit config",
              tooltip: "Make changes to the scraping configuration.",
              command: "dynatrace-extensions.codelens.scrapeJMXMetrics",
              arguments: [true],
            }),
          );
        }
        // Status lens
        const scrapedMetrics = Object.keys(this.jmxData).length;
        this.codeLenses.push(
          new vscode.CodeLens(range, {
            title:
              this.lastScrape === "N/A"
                ? this.lastScrape
                : `${scrapedMetrics} metrics (${this.lastScrape.substring(5)})`,
            tooltip:
              this.lastScrape === "N/A"
                ? "Data has not been scraped yet."
                : `${this.lastScrape}. Found ${scrapedMetrics} metrics.`,
            command: "",
            arguments: [],
          }),
        );
      }
    }

    return this.codeLenses;
  }

  /**
   * Metric scraping workflow. If no previous details are known, these are collected.
   * Upon successful scraping and processing, timestamp is updated.
   * @param changeConfig collect the details required for scraping, even if they exist already
   * @returns void
   */
  private async scrapeJMXMetrics(changeConfig: boolean = false) {
    // Only collect details if none are available
    if (!this.jmxUrl || changeConfig) {
      const details = await this.collectJMXScrapingDetails();
      if (!details) {
        return;
      }
      // Clear cached data since we're now scraping a different endpoint/file
      this.cachedData.setJMXData({});
    }
    const scrapeSuccess = await this.JMXscrape();
    if (scrapeSuccess) {
      this.lastScrape = `Last scraped at: ${new Date().toLocaleTimeString()}`;
      this._onDidChangeCodeLenses.fire();
    }
  }

  /**
   * Endpoint detail collection workflow. This workflow has been created to support
   * all the authenticaiton schemes that JMX Extensions 2.0 support.
   * @returns whether data collection was successful (i.e. mandatory details collected) or not
   */
  private async collectJMXScrapingDetails(): Promise<boolean> {
    // Endpoint URL
    this.method = (await vscode.window.showQuickPick(["Endpoint"], {
      title: "Scrape data - method selection",
      placeHolder: "Select your scraping method",
      canPickMany: false,
      ignoreFocusOut: true,
    })) as ScrapingMethod;
    switch (this.method) {
      case "Endpoint":
        this.jmxUrl = await vscode.window.showInputBox({
          title: "Scrape data - endpoint URL",
          placeHolder: "Enter your full metrics endpoint URL",
          prompt: "Mandatory",
          ignoreFocusOut: true,
        });
        if (!this.jmxUrl) {
          return false;
        }
        // Endpoint connectivity scheme
        this.jmxAuth = (await vscode.window.showQuickPick(
          ["No authentication", "Username & password"],
          {
            title: "Scrape data - endpoint authentication",
            placeHolder: "Select your endpoint's authentication scheme",
            canPickMany: false,
            ignoreFocusOut: true,
          },
        )) as JMXAuth;
        // Endpoint authentication details
        switch (this.jmxAuth) {
          case "No authentication":
            return true;
          case "Username & password":
            this.jmxUsername = await vscode.window.showInputBox({
              title: "Scrape data - endpoint authentication",
              placeHolder: "Enter the username to use for authentication",
              prompt: "Mandatory",
              ignoreFocusOut: true,
            });
            this.jmxPassword = await vscode.window.showInputBox({
              title: "Scrape data - endpoint authentication",
              placeHolder: "Enter the password to use for authentication",
              prompt: "Mandatory",
              ignoreFocusOut: true,
              password: true,
            });
            if (!this.jmxUsername || !this.jmxPassword) {
              return false;
            }
            return true;
          default:
            return false;
        }
      default:
        return false;
    }
  }

  /**
   * Scrapes jmx metrics.
   * This involves connecting to the endpoint, reading the data, and processing it.
   * @returns whether scraping was successful (any errors) or not
   */
  private async JMXscrape() {
    if (!this.jmxUrl) {
      return false;
    }
    try {
      switch (this.method) {
        case "Endpoint":
          switch (this.jmxAuth) {
            case "No authentication":
              await axios.get(this.jmxUrl).then(res => {
                this.processJMXData(res.data as string);
              });
              return true;
            case "Username & password":
              if (!this.jmxUsername || !this.jmxPassword) {
                return false;
              }
              await axios
                .get(this.jmxUrl, {
                  auth: { username: this.jmxUsername, password: this.jmxPassword },
                })
                .then(res => {
                  this.processJMXData(res.data as string);
                });
              return true;
            default:
              return false;
          }
      }
    } catch (err) {
      console.log(err);
      return false;
    }
  }

  /**
   * Processes raw JMX data line by line and extracts the details relevant
   * for Extensions 2.0. The data is cached with a cached data provider for access
   * in other parts of the VSCode extension.
   * @param data raw data from a JMX Endpoint
   */
  private processJMXData(data: string) {
    const scrapedMetrics: JMXData = {};
    console.log(data);

    // data
    //   .trim()
    //   .split("\n")
    //   .forEach(line => {
    //     // # HELP defines description of a metric
    //     if (line.startsWith("# HELP")) {
    //       const key = line.split("# HELP ")[1].split(" ")[0];
    //       const description = line.split(`${key} `)[1];
    //       if (!(key in scrapedMetrics)) {
    //         scrapedMetrics[key] = {} as JMXDetails;
    //       }
    //       scrapedMetrics[key].description = description;
    //       // # TYPE defines type of a metric
    //     } else if (line.startsWith("# TYPE")) {
    //       const key = line.split("# TYPE ")[1].split(" ")[0];
    //       let type = line.split(`${key} `)[1];
    //       if (type === "counter") {
    //         type = "count";
    //       }
    //       if (!(key in scrapedMetrics)) {
    //         scrapedMetrics[key] = {} as JMXDetails;
    //       }
    //       scrapedMetrics[key].type = type;
    //       // Any other line contains dimensions and the value
    //     } else {
    //       const [key, dimensionsStr] = line.split(line.includes("{") ? "{" : " ");
    //       if (!(key in scrapedMetrics)) {
    //         scrapedMetrics[key] = {} as JMXDetails;
    //       }
    //       // make sure lines without dimensions have the correct keys
    //       // if line includes dimensions, find them
    //       if (dimensionsStr.includes("}")) {
    //         const dimensions = dimensionsStr.slice(0, dimensionsStr.length - 1);
    //         dimensions.split(",").forEach(dimension => {
    //           if (dimension.includes("=")) {
    //             if (!("dimensions" in scrapedMetrics[key])) {
    //               scrapedMetrics[key].dimensions = [];
    //             }
    //             const dKey = dimension.split("=")[0];
    //             if (!scrapedMetrics[key].dimensions?.includes(dKey)) {
    //               scrapedMetrics[key].dimensions?.push(dKey);
    //             }
    //           }
    //         });
    //       }
    //     }
    //   });
    // this.cachedData.setJMXData(scrapedMetrics);
  }
}
