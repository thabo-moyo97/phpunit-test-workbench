import { spawn } from 'child_process';
import * as readline from 'readline';
import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import { Settings } from '../settings';
import { Logger } from '../output';
import { TestRunResultParser } from './TestRunResultParser';
import { TestExecutionRequest } from './TestExecutionRequest';
import { TestItemMap } from '../loader/tests/TestItemMap';
import { DebugConfigQuickPickItem } from '../ui/DebugConfigQuickPickItem';
import { TestResultStatus } from './TestResult';
import { ContinuousTestRunDefinition } from './continuous/ContinuousTestRunDefinition';
import { TestRunSummary } from './TestRunSummary';
import { TestCoverageMap } from './coverage/TestCoverageMap';

export class TestRunner {
    private ctrl: vscode.TestController;
    private itemMap: TestItemMap;
    private coverageMap: TestCoverageMap;
    private diagnosticCollection: vscode.DiagnosticCollection;
    private settings: Settings;
    private logger: Logger;
    private testItemQueue: Map<string, vscode.TestItem>;
    private testDiagnosticMap: Map<string, vscode.Diagnostic[]>;
    private activeContinuousRuns: Map<vscode.RelativePattern, ContinuousTestRunDefinition>;
    private mostRecentTestRunRequest?: { request: vscode.TestRunRequest, debug: boolean, coverage: boolean };
    private additionalPatterns: Map<vscode.RelativePattern, Set<vscode.RelativePattern>>;

    constructor(ctrl: vscode.TestController, itemMap: TestItemMap, coverageMap: TestCoverageMap, diagnosticCollection: vscode.DiagnosticCollection, settings: Settings, logger: Logger) {
        this.ctrl = ctrl;
        this.itemMap = itemMap;
        this.coverageMap = coverageMap;
        this.diagnosticCollection = diagnosticCollection;
        this.settings = settings;
        this.logger = logger;
        this.testItemQueue = new Map<string, vscode.TestItem>();
        this.testDiagnosticMap = new Map<string, vscode.Diagnostic[]>();
        this.activeContinuousRuns = new Map<vscode.RelativePattern, ContinuousTestRunDefinition>();
        this.additionalPatterns = new Map<vscode.RelativePattern, Set<vscode.RelativePattern>>();
    }

    public async run(request: vscode.TestRunRequest, cancel: vscode.CancellationToken, debug: boolean = false, coverage: boolean = false) {
        // Initialise the test run
        const run = this.ctrl.createTestRun(request);
        const executionRequests: TestExecutionRequest[] = [];
        this.testItemQueue.clear();
        this.testDiagnosticMap.clear();
        this.diagnosticCollection.clear();

        // Add handler to clean up test coverage temporary files when test run is disposed
        if (coverage) {
            run.onDidDispose(async () => {
                for (let request of executionRequests) {
                    let coverageFileUri = request.getCoverageOutputFileUri();
                    if (coverageFileUri) {
                        await fs.rm(coverageFileUri.fsPath, { recursive: true, force: true });
                    }
                }
            });
        }

        // Start test run logging
        this.logger.setTestRun(run);
        if (this.settings.get('log.autoDisplayOutput') === 'testRunAll') {
            this.logger.showOutputChannel();
        }

        // Get tag from run profile (if set)
        let tagId = request.profile?.tag?.id;

        if (request.include && request.include.length > 0) {
            // Test run is only for a subset of test items
            let parentTestItem = request.include[0];
            let parentTestItemDef = this.itemMap.getTestDefinition(parentTestItem.id)!;

            // Enqueue this TestItem and all of its children
            this.testItemQueue = this.buildTestRunQueue(run, this.testItemQueue, parentTestItem, tagId);

            // Create TestExecutionRequest for the TestItem and add to the list of executions to be run
            let testExecutionRequest = await TestExecutionRequest.createForTestItem(parentTestItem, parentTestItemDef, this.settings, this.logger, coverage, tagId);
            if (testExecutionRequest) {
                executionRequests.push(testExecutionRequest);
            }
        } else {
            // Test run is for all test items (potentially across multiple workspaces)
            let workspaceFolders: vscode.WorkspaceFolder[] = [];
            for (let [key, parentTestItem] of this.ctrl.items) {
                // Enqueue this TestItem and all of its children
                this.testItemQueue = this.buildTestRunQueue(run, this.testItemQueue, parentTestItem, tagId);

                // Check if this workspace folder has already been encountered during the run
                let workspaceFolder = vscode.workspace.getWorkspaceFolder(parentTestItem.uri!);
                if (workspaceFolder && workspaceFolders.indexOf(workspaceFolder) <= -1) {
                    workspaceFolders.push(workspaceFolder);
                }
            }

            // Create a TestExecutionRequest for each unique workspace folder and add to the list of executions to be run
            for (let workspaceFolder of workspaceFolders) {
                let testExecutionRequest = await TestExecutionRequest.createForWorkspaceFolder(workspaceFolder, this.settings, this.logger, coverage, tagId);
                if (testExecutionRequest) {
                    executionRequests.push(testExecutionRequest);
                }
            }
        }

        // Dispatch each of the test execution requests in sequence
        for (let executionRequest of executionRequests) {
            if (cancel.isCancellationRequested !== true) {
                let summary: TestRunSummary = await this.dispatchExecutionRequest(run, executionRequest, cancel, debug);

                // Print execution summary to logs
                this.logTestRunSummary(summary);

                // Add diagnostics to source code
                this.logFailuresAsDiagnostics(summary, executionRequest.getWorkspaceFolder());

                // If this is a code coverage run, process the results file now
                if (coverage) {
                    await this.coverageMap.loadCoverageFile(executionRequest.getCoverageOutputFileUri()!);
                    for (let fileCoverage of this.coverageMap.getFileCoverage()) {
                        run.addCoverage(fileCoverage);
                    }
                }
            }
        }

        // Close out the test run
        this.logger.setTestRun(undefined);
        run.end();

        // Store as the most recent request so that it can be re-executed in the future
        this.mostRecentTestRunRequest = { request: request, debug: debug, coverage: coverage };
    }

    public async rerunMostRecentRunRequest(cancel: vscode.CancellationToken) {
        if (!this.mostRecentTestRunRequest) {
            this.logger.error('Unable to re-run test, as no test runs have been completed successfully yet.', true);
        }

        let previousRequest = this.mostRecentTestRunRequest!;
        let request = new vscode.TestRunRequest(
            previousRequest.request.include,
            previousRequest.request.exclude,
            previousRequest.request.profile,
            previousRequest.request.continuous
        );
        this.run(request, cancel, previousRequest.debug, previousRequest.coverage);
    }

    private async dispatchExecutionRequest(run: vscode.TestRun, request: TestExecutionRequest, cancel: vscode.CancellationToken, debug: boolean = false): Promise<TestRunSummary> {
        let workspaceFolder = request.getWorkspaceFolder();
        
        // If test run is being debugged, prompt user to select debug configuration
        if (debug) {
            // Get launch configurations for workspace
            let launch = vscode.workspace.getConfiguration('launch', workspaceFolder);
            let launchConfigs: any = launch.get('configurations');

            let launchOptions: vscode.QuickPickItem[] = [];
            for (let launchConfig of launchConfigs) {
                if (launchConfig.type === 'php') {
                    launchOptions.push(new DebugConfigQuickPickItem(
                        launchConfig.name,
                        launchConfig.port ?? this.settings.get('xdebug.clientPort', 9003),
                        launchConfig.hostname ?? this.settings.get('xdebug.clientHost', 'localhost')
                    ));
                }
            }

            let selectedQuickPickItem;
            if (launchOptions.length === 1) {
                selectedQuickPickItem = launchOptions[0];
            } else if (launchOptions.length > 1) {
                // Display quick pick to display available debug configurations
                selectedQuickPickItem = await vscode.window.showQuickPick(launchOptions, {
                    canPickMany: false,
                    title: `Select debug config for workspace folder '${workspaceFolder.name}'`
                });
            }

            if (selectedQuickPickItem && (selectedQuickPickItem instanceof DebugConfigQuickPickItem)) {
                // Add Xdebug parameters to PHP command line arguments
                request.setArgPhp('-dxdebug.mode', 'debug');
                request.setArgPhp('-dxdebug.start_with_request', 'yes');
                request.setArgPhp('-dxdebug.client_port', String(selectedQuickPickItem.getClientPort()));
                request.setArgPhp('-dxdebug.client_host', selectedQuickPickItem.getClientHost());

                // Start debug session
                await vscode.debug.startDebugging(workspaceFolder, selectedQuickPickItem.label);
            } else {
                this.logger.warn('Unable to locate a valid debug configuration for this workspace. Test run will be executed without debugging enabled.');
            }
        }

        // Set the command string to the PHP binary
        let commandString = await request.getCommandString();
        let commandArguments = await request.getCommandArguments();

        // Set up handler for test run cancellation signal
        let abortController = new AbortController();
        cancel.onCancellationRequested(e => abortController.abort());

        // Set up parser to capture test results and update TestItems
        let parser = new TestRunResultParser(run, this.testItemQueue, this.settings, this.logger);

        // Attempt to run command
        // For a good explanation of why we can set event listners after spawning the 
        // child process, see https://stackoverflow.com/questions/59798310/when-does-node-spawned-child-process-actually-start
        this.logger.trace('Executing child process:' + commandString + ' ' + commandArguments.join(' '));
        this.logger.info('Starting test run...\r\n');
        var child = spawn(commandString, commandArguments, {signal: abortController.signal});

        // Handle data written to stderr
        child.stderr.setEncoding('utf-8');
        child.stderr.on('data', (data) => {
            this.writeFatalErrorToLog(data, run);
        });

        let buffer = '';
        const reader = readline.createInterface({ input: child.stdout });
        for await(let line of reader) {
            buffer += line;
            parser.parseLine(line);
        }

        // If test execution was running in debug mode, stop debugging on completion 
        if (debug) {
            vscode.debug.stopDebugging();
        }

        child.on('error', (error) => {
            this.logger.trace('Error occurred managing the child process: ' + error);

            // If test execution was running in debug mode, stop debugging on completion 
            if (debug) {
                vscode.debug.stopDebugging();
            }

            return parser.getSummary();
        });

        child.on('exit', (code, signal) => {
            this.logger.trace('Child process completed with exit code: ' + code);

            // If test execution was running in debug mode, stop debugging on completion 
            if (debug) {
                vscode.debug.stopDebugging();
            }

            return parser.getSummary();
        });

        return parser.getSummary();
    }

    private writeFatalErrorToLog(error: string, run: vscode.TestRun) {
        this.logger.error(``, false, { testRun: run });
        this.logger.error(`---- fatal error ----`, false, { testRun: run });
        this.logger.error(error, false, { testRun: run });
        this.logger.error(`---------------------`, false, { testRun: run });
        if (this.settings.get('log.autoDisplayOutput', 'errorsOnly') !== 'never') {
            this.logger.showOutputChannel();
        }
    }

    private logTestRunSummary(summary: TestRunSummary) {
        // Get summary counts for values reported by the command line tool, and those captured by the extension
        let reported = summary.getReportedSummaryCounts();
        let actuals = summary.getActualSummaryCounts();

        // Created formatted output string
        let output = `Summary reported by PHPUnit   => `;
        if (reported.tests <= 0) {
            output += `No test summary information available.`;
        } else {
            output += `Tests: ${reported.tests}, Assertions: ${reported.assertions}`;
            if (reported.failures > 0) {
                output += `, Failures: ${reported.failures}`;
            }
            if (reported.warnings > 0) {
                output += `, Warnings: ${reported.warnings}`;
            }
            if (reported.skipped > 0) {
                output += `, Skipped: ${reported.skipped}`;
            }
            if (reported.errors > 0) {
                output += `, Errors: ${reported.errors}`;
            }
            if (reported.risky > 0) {
                output += `, Risky: ${reported.risky}`;
            }
        }
        output += `\r\nSummary captured by extension => `;
        if (actuals.tests <= 0) {
            output += `No test summary information available.`;
        } else {
            output += `Tests: ${actuals.tests}`;
            if (actuals.passed > 0) {
                output += `, Passed: ${actuals.passed}`;
            }
            if (actuals.failures > 0) {
                output += `, Failures: ${actuals.failures}`;
            }
            if (actuals.warnings > 0) {
                output += `, Warnings: ${actuals.warnings}`;
            }
            if (actuals.skipped > 0) {
                output += `, Skipped: ${actuals.skipped}`;
            }
            if (actuals.errors > 0) {
                output += `, Errors: ${actuals.errors}`;
            }
        }

        // Print summary to log
        this.logger.info('');
        this.logger.info('-'.repeat(25));
        this.logger.info(output);
        this.logger.info('-'.repeat(25));
        this.logger.info('');
    }

    private async logFailuresAsDiagnostics(summary: TestRunSummary, workspaceFolder: vscode.WorkspaceFolder) {
        if (this.settings.get('log.displayFailuresAsErrorsInCode', false, workspaceFolder) !== true) {
            return;
        }

        let resultTestItems = summary.getTestItems();
        for (let testItem of resultTestItems) {
            // Only display diagnostics for test failures
            let status = summary.getTestItemStatus(testItem);
            if (status !== TestResultStatus.failed) {
                continue;
            }

            // Get the results for the test item
            let results = summary.getTestItemResults(testItem);
            for (let result of results) {
                // Only display diagnostics if the test failure contains a message
                let message = result.getMessage();
                if (!message) {
                    continue;
                }

                // Only display diagnostics if the test failure contains line item range details
                let messagePosition = result.getMessagePosition();
                if (!messagePosition) {
                    continue;
                }

                // Add diagnostic to display error on correct line in editor
                let testDocumentUri = testItem.uri!;
                let testMessageLineItemIdx = messagePosition.line;
                let diagnostics = this.testDiagnosticMap.get(testDocumentUri.toString());
                if (!diagnostics) {
                    diagnostics = [];
                }

                let testDocument = await vscode.workspace.openTextDocument(testDocumentUri);
                let testDocumentLine = testDocument.lineAt(testMessageLineItemIdx);

                let diagnosticRange = new vscode.Range(
                    new vscode.Position(testMessageLineItemIdx, testDocumentLine.firstNonWhitespaceCharacterIndex),
                    new vscode.Position(testMessageLineItemIdx, testDocumentLine.text.length)
                );
                let diagnostic = new vscode.Diagnostic(diagnosticRange, message, vscode.DiagnosticSeverity.Error);
                diagnostic.source = 'PHPUnit Test Workbench';
                diagnostics.push(diagnostic);
                this.testDiagnosticMap.set(testDocumentUri.toString(), diagnostics);
            }
        }

        // Apply diagnostics collected during parsing test run results
        this.testDiagnosticMap.forEach((diagnostics, file) => {
            this.diagnosticCollection.set(vscode.Uri.parse(file), diagnostics);
        });
    }

    private buildTestRunQueue(run: vscode.TestRun, queue: Map<string, vscode.TestItem>, item: vscode.TestItem, tagId?: string): Map<string, vscode.TestItem> {
        // Check if this is a test method
        if (item.canResolveChildren === false) {
            if (!tagId) {
                // No tag filter - always enqueue
                run.enqueued(item);
            } else {
                // Check if the TestItem has been tagged with the filter specified
                for (let tag of item.tags) {
                    if (tag.id === tagId) {
                        run.enqueued(item);
                        break;
                    }
                }
            }
        }
        
        // Add to the queue for later lookup by ID
        queue.set(item.id, item);
        item.children.forEach(child => this.buildTestRunQueue(run, queue, child, tagId));
        return queue;
    }

    /*
     * Continuous test run functionality
    */
    public addContinuousTestRunDetails(request: vscode.TestRunRequest, cancel: vscode.CancellationToken, patterns: vscode.RelativePattern[], debug: boolean = false) {
        for (let pattern of patterns) {
            let continuousRunDef = new ContinuousTestRunDefinition(
                request,
                cancel,
                pattern,
                debug
            );
            this.activeContinuousRuns.set(pattern, continuousRunDef);

            // Add additional patterns from settings
            const additionalPatterns = new Set<vscode.RelativePattern>();
            const configPatterns = this.settings.get('continuous.additionalPatterns', []) as string[];
            
            if (configPatterns.length > 0) {
                const workspaceFolder = vscode.workspace.getWorkspaceFolder(pattern.baseUri);
                if (workspaceFolder) {
                    for (const configPattern of configPatterns) {
                        this.logger.info(`Adding additional pattern for continuous run: ${configPattern}`);
                        additionalPatterns.add(new vscode.RelativePattern(workspaceFolder, configPattern));
                    }
                }
            }
            
            this.additionalPatterns.set(pattern, additionalPatterns);
        }

        // Handle continuous run cancellation
        cancel.onCancellationRequested(event => {
            for (let pattern of patterns) {
                this.activeContinuousRuns.delete(pattern);
                this.additionalPatterns.delete(pattern);
            }
        });
    }
    /*
     * TODO
     * - Clean up the logic for checking if a document matches an active continuous run pattern
     * - Optimise code, written in a bit of a rush to get it working!
    */
    public checkForActiveContinuousRun(document: vscode.TextDocument) { 
        const relativePath = vscode.workspace.asRelativePath(document.uri, false);
        console.debug('🔍 Checking for active continuous run:', {
            document: relativePath
        });

        // Check all patterns for a match
        for (let [testPattern, continuousRun] of this.activeContinuousRuns) {
            const testFile = testPattern.pattern;
            console.debug('🔄 Checking Test Pattern:', {
                testFile,
                currentFile: relativePath
            });

            const isGlobPattern = testFile.includes('*') || testFile.includes('{');
            if (isGlobPattern) {
                this.run(
                    continuousRun.createTestRunRequest(), 
                    continuousRun.getCancellationToken(), 
                    continuousRun.isDebug()
                );
                return;
            }
            
            // Handle exact file patterns
            const methodMatch = testFile.match(/::(test\w+)$/);
            const methodName = methodMatch ? methodMatch[1] : null;
            const testFilePath = methodName ? testFile.replace(`::{methodName}`, '') : testFile;

            if (testFilePath === relativePath) {
                console.debug('✅ Matched test file directly');
                this.runAllContinuousTests();
                return;
            }

            const sourceFile = this.convertTestPathToSourcePath(testFilePath);
            if (sourceFile === relativePath) {
                console.debug('✅ Matched source file through PSR-4 mapping:', {
                    sourceFile,
                    testFile: testFilePath,
                    method: methodName
                });
                this.runAllContinuousTests();
                return;
            }

            // Check path mappings from settings
            const pathMappings = this.settings.get('continuous.pathMappings', []) as Array<{
                pattern: string;
                testPattern: string;
            }>;

            for (const mapping of pathMappings) {
                const sourcePattern = new RegExp(mapping.pattern);
                const testPattern = new RegExp(mapping.testPattern);
                
                if (sourcePattern.test(relativePath) || testPattern.test(relativePath)) {
                    console.debug('✅ Matched path mapping pattern:', {
                        mapping,
                        file: relativePath
                    });
                    this.runAllContinuousTests();
                    return;
                }
            }
        }
    }

    private runAllContinuousTests() {
        console.debug(`🚀 Running all continuous tests`);
        for (const [_, continuousRun] of this.activeContinuousRuns) {
            this.runContinuousTest(continuousRun);
        }
    }

    private convertTestPathToSourcePath(testPath: string): string {
        // Handle common PSR-4 test file patterns
        const patterns = [
            { test: /^tests\/(.+)Test\.php$/, source: 'src/$1.php' },
            { test: /^test\/(.+)Test\.php$/, source: 'src/$1.php' },
            { test: /^tests\/(.+)\/(.+)Test\.php$/, source: 'src/$1/$2.php' },
            { test: /^tests\/App\/(.+)Test\.php$/, source: 'app/$1.php' },
            { test: /^tests\/Test\/(.+)Test\.php$/, source: 'app/$1.php' }
        ];

        for (const pattern of patterns) {
            if (pattern.test.test(testPath)) {
                return testPath.replace(pattern.test, pattern.source);
            }
        }

        return testPath;
    }

    private runContinuousTest(continuousRun: ContinuousTestRunDefinition) {
        if (!continuousRun) {
            return;
        }

        // Document falls under scope of an active continuous run - start a new test run now
        this.run(
            continuousRun.createTestRunRequest(), 
            continuousRun.getCancellationToken(), 
            continuousRun.isDebug()
        );
    }

    public removeContinuousRunForDeletedFile(deletedFileUri: vscode.Uri) {
        // Try and match the old file to an existing continuous run pattern
        for (let pattern of this.activeContinuousRuns.keys()) {
            let patternUri = pattern.baseUri.with({ path: pattern.baseUri.path + '/' + pattern.pattern });
            if (patternUri.toString() === deletedFileUri.toString()) {
                // Remove pattern from the list of active runs
                this.activeContinuousRuns.delete(pattern);
                return;
            }
        }
    }
}