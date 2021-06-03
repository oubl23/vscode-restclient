import { ExtensionContext, Range, TextDocument, TextEditor, ViewColumn, window } from 'vscode';
import Logger from '../logger';
import { RestClientSettings } from '../models/configurationSettings';
import { HistoricalHttpRequest, HttpRequest } from '../models/httpRequest';
import { RequestParserFactory } from '../models/requestParserFactory';
import { trace } from "../utils/decorator";
import { HttpClient } from '../utils/httpClient';
import { RequestState, RequestStatusEntry } from '../utils/requestStatusBarEntry';
import { RequestVariableCache } from "../utils/requestVariableCache";
import { Selector } from '../utils/selector';
import { UserDataManager } from '../utils/userDataManager';
import { VariableUtility } from '../utils/variableUtility';
import { getCurrentTextDocument } from '../utils/workspaceUtility';
import { HttpResponseTextDocumentView } from '../views/httpResponseTextDocumentView';
import { HttpResponseWebview } from '../views/httpResponseWebview';
import * as Constants from '../common/constants';
import { LastDocmentCache } from '../utils/LastDocumentCache';

export class RequestController {
    private readonly _restClientSettings: RestClientSettings = RestClientSettings.Instance;
    private _requestStatusEntry: RequestStatusEntry;
    private _httpClient: HttpClient;
    private _webview: HttpResponseWebview;
    private _textDocumentView: HttpResponseTextDocumentView;
    private _lastRequest?: HttpRequest;
    private _lastPendingRequest?: HttpRequest;

    public constructor(context: ExtensionContext) {
        this._requestStatusEntry = new RequestStatusEntry();
        this._httpClient = new HttpClient();
        this._webview = new HttpResponseWebview(context);
        this._webview.onDidCloseAllWebviewPanels(() => this._requestStatusEntry.update({ state: RequestState.Closed }));
        this._textDocumentView = new HttpResponseTextDocumentView();
    }

    public preRun(range: Range){
        
        let ranges:Range[] = [];

        let stack:Range[] = [];

        stack.push(range)

        while(stack.length != 0){
            let len = stack.length;

            for(let i = 0 ; i < len; i++){
                let r = stack.shift();

                if(r == undefined){
                    continue;
                }

                let requestNames = this.getBeforeRequest(r);

                if(requestNames == undefined){
                    continue;
                }
                let nameList = requestNames.split('.');
                for(const name of nameList){
                    let ra = this.getBeforeRange(r,name);
                    if(ra == undefined){
                        continue;
                    }else{
                        if( ranges.map(v=>v.start.line).includes(ra.start.line) ){
                            return [];
                        }
                        ranges.push(ra);
                        stack.push(ra);
                    }
                }
            }
        }
        return ranges;
    }

    private getBeforeRequest(range: Range){
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }
        let selectedText: string | null;
        if (editor.selection.isEmpty || range) {
            const activeLine = range?.start.line ?? editor.selection.active.line;
            selectedText = Selector.getDelimitedText(editor.document.getText(), activeLine);
        } else {
            selectedText = editor.document.getText(editor.selection);
        }
        if(selectedText == null){
            return;
        }
        
        let match: RegExpExecArray | null;
        if( match = Constants.BeforeDefinitionRegex.exec(selectedText)){
            let [, requestName] = match;
            return requestName;
        }
        return;
    }

    private getBeforeRange(range:Range, requestName: string){
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }
        let selectedText: string | null;
        if (editor.selection.isEmpty || range) {
            const activeLine = range?.start.line ?? editor.selection.active.line;
            selectedText = Selector.getDelimitedText(editor.document.getText(), activeLine);
        } else {
            selectedText = editor.document.getText(editor.selection);
        }
        if(selectedText == null){
            return;
        }
        
        if(Constants.RequestVariableDefinitionWithNameRegexFactory(requestName).test(selectedText)){
            return;
        }
        const documentLines = document.getText().split(Constants.LineSplitterRegex);
        const ranges = VariableUtility.getRequestVariableDefinitionRanges(documentLines, requestName);
        if(ranges.length == 1){
            return ranges[0];
        }
        return;
    }

    @trace('Request')
    public async run(range: Range) {
        const editor = window.activeTextEditor;
        const document = getCurrentTextDocument();
        if (!editor || !document) {
            return;
        }
        LastDocmentCache.set(document);
        const ranges = this.preRun(range);
        for(let i = ranges.length - 1 ; i >= 0; i--){
            await this.request(ranges[i],editor,document);
        }
        await this.request(range,editor,document);
    }

    public async request(range: Range,editor:TextEditor, document: TextDocument) {
        const selectedRequest = await Selector.getRequest(editor, range);
        if (!selectedRequest) {
            return;
        }

        const { text, name, warnBeforeSend } = selectedRequest;

        if (warnBeforeSend) {
            const note = name ? `Are you sure you want to send the request "${name}"?` : 'Are you sure you want to send this request?';
            const userConfirmed = await window.showWarningMessage(note, 'Yes', 'No');
            if (userConfirmed !== 'Yes') {
                return;
            }
        }

        // parse http request
        const httpRequest = await RequestParserFactory.createRequestParser(text).parseHttpRequest(name);

        await this.runCore(httpRequest, document, editor);
    }

    @trace('Rerun Request')
    public async rerun() {
        if (!this._lastRequest) {
            return;
        }

        await this.runCore(this._lastRequest);
    }

    @trace('Cancel Request')
    public async cancel() {
        this._lastPendingRequest?.cancel();

        this._requestStatusEntry.update({ state: RequestState.Cancelled });
    }

    private async runCore(httpRequest: HttpRequest, document?: TextDocument, editor?:TextEditor) {
        // clear status bar
        this._requestStatusEntry.update({ state: RequestState.Pending });

        // set last request and last pending request
        this._lastPendingRequest = this._lastRequest = httpRequest;

        // set http request
        try {
            const response = await this._httpClient.send(httpRequest);
            console.log(response)
            // check cancel
            if (httpRequest.isCancelled) {
                return;
            }

            this._requestStatusEntry.update({ state: RequestState.Received, response });

            if (httpRequest.name && document) {
                RequestVariableCache.add(document, httpRequest.name, response);
            }

            try {
                const activeColumn = editor ? editor.viewColumn: window.activeTextEditor!.viewColumn ;
                const previewColumn = this._restClientSettings.previewColumn === ViewColumn.Active
                    ? activeColumn
                    : ((activeColumn as number) + 1) as ViewColumn;
                if (this._restClientSettings.previewResponseInUntitledDocument) {
                    this._textDocumentView.render(response, previewColumn);
                } else if (previewColumn) {
                    this._webview.render(response, previewColumn);
                }
            } catch (reason) {
                Logger.error('Unable to preview response:', reason);
                window.showErrorMessage(reason);
            }

            // persist to history json file
            await UserDataManager.addToRequestHistory(HistoricalHttpRequest.convertFromHttpRequest(httpRequest));
        } catch (error) {
            // check cancel
            if (httpRequest.isCancelled) {
                return;
            }

            if (error.code === 'ETIMEDOUT') {
                error.message = `Request timed out. Double-check your network connection and/or raise the timeout duration (currently set to ${this._restClientSettings.timeoutInMilliseconds}ms) as needed: 'rest-client.timeoutinmilliseconds'. Details: ${error}.`;
            } else if (error.code === 'ECONNREFUSED') {
                error.message = `The connection was rejected. Either the requested service isn’t running on the requested server/port, the proxy settings in vscode are misconfigured, or a firewall is blocking requests. Details: ${error}.`;
            } else if (error.code === 'ENETUNREACH') {
                error.message = `You don't seem to be connected to a network. Details: ${error}`;
            }
            this._requestStatusEntry.update({ state: RequestState.Error });
            Logger.error('Failed to send request:', error);
            window.showErrorMessage(error.message);
        } finally {
            if (this._lastPendingRequest === httpRequest) {
                this._lastPendingRequest = undefined;
            }
        }
    }

    public dispose() {
        this._requestStatusEntry.dispose();
        this._webview.dispose();
    }
}