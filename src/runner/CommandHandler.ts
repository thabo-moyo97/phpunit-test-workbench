import * as vscode from 'vscode';
import { Settings } from "../settings";
import { Logger } from "../output";
import { TestFileParser } from '../parser/TestFileParser';
import { TestItemMap } from '../parser/TestItemMap';
import { TestRunner } from "./TestRunner";

export class CommandHandler {
    private ctrl: vscode.TestController;
    private parser: TestFileParser;
    private itemMap: TestItemMap;
    private runner: TestRunner;
    private settings: Settings;
    private logger: Logger;

    constructor(
        ctrl: vscode.TestController,
        parser: TestFileParser,
        itemMap: TestItemMap,
        runner: TestRunner,
        settings: Settings,
        logger: Logger
    ) {
        this.ctrl = ctrl;
        this.parser = parser;
        this.itemMap = itemMap;
        this.runner = runner;
        this.settings = settings;
        this.logger = logger;
    }

    public async execute(command: string) {
        const editor = vscode.window.activeTextEditor;
        let testItem: vscode.TestItem | undefined;
        let includes: vscode.TestItem[];
        let request: vscode.TestRunRequest;
        let cancellationTokenSource = new vscode.CancellationTokenSource();

        switch (command) {
            case 'run.method':
                this.logger.info(`Running command: Run test method...`);

                // Identify the file open in the active editor
                if (!editor) {
                    this.logger.warn(`No active editor found - cannot identify class to run!`);
                    return;
                }
                if (editor.document.languageId !== 'php') {
                    this.logger.warn(`This command can only be executed on a PHPUnit test class (*.php file). If you have a PHPUnit test class open, make sure it is the active editor by clicking in it and then try again.`);
                    return;
                }

                // Find test item definition for the document
                let classTestItem = this.itemMap.getTestItemForClass(editor.document.uri);
                if (!classTestItem) {
                    this.logger.warn(`No test item definition was found for the current class. Aborting test run.`);
                    return;
                }

                // Find the closest method name above the location of the cursor
                let currentLine = editor.selection.active.line;
                for (let [id, methodTestItem] of classTestItem.children) {
                    if (methodTestItem.range && methodTestItem.range.contains(editor.selection.active)) {
                        testItem = methodTestItem;
                    }
                }
                if (!testItem) {
                    this.logger.warn(`No test item definition was found at the current cursor location. Aborting test run.`);
                    return;
                }

                // Create test run request
                includes = [ testItem ];
                request = new vscode.TestRunRequest(includes);
                await this.runner.run(request, cancellationTokenSource.token);
                this.logger.info(`Command complete: Run test method`);
                break;
            case 'run.class':
                this.logger.info(`Running command: Run test class...`);

                // Identify the file open in the active editor
                if (!editor) {
                    this.logger.warn(`No active editor found - cannot identify class to run!`);
                    return;
                }
                if (editor.document.languageId !== 'php') {
                    this.logger.warn(`This command can only be executed on a PHPUnit test class (*.php file). If you have a PHPUnit test class open, make sure it is the active editor by clicking in it and then try again.`);
                    return;
                }

                // Find test item definition for the document
                testItem = this.itemMap.getTestItemForClass(editor.document.uri);
                if (!testItem) {
                    this.logger.warn(`No test item definition was found for the current class. Aborting test run.`);
                    return;
                }
                
                // Create test run request
                includes = [ testItem ];
                request = new vscode.TestRunRequest(includes);
                await this.runner.run(request, cancellationTokenSource.token);
                this.logger.info(`Command complete: Run test class`);
                break;
            case 'run.suite':

                break;
            case 'run.all':
                this.logger.info(`Running command: Run all tests...`);

                // Ensure all test files have been parsed before starting the run
                await this.parser.refreshTestFilesInWorkspace();

                // Create test run request
                request = new vscode.TestRunRequest();
                await this.runner.run(request, cancellationTokenSource.token);
                this.logger.info(`Command complete: Run all tests`);
                break;
        }
    }
}