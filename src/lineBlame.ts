import * as vscode from 'vscode';
import { getConfig } from './config';
import { DataSource } from './dataSource';
import { getLanguage, t } from './l10n';
import { Logger } from './logger';
import { RepoManager } from './repoManager';
import { GitLineBlame } from './types';
import { abbrevCommit, getPathFromUri, getRelativeTimeDiff } from './utils';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

/**
 * The time (in milliseconds) the cursor must stay on a line before it's blamed.
 */
const BLAME_DELAY = 150;

/**
 * Shows who last changed the line the cursor is on, and when & why (the author, date & subject of the commit), at the end of the line
 * in the editor (the `git-map.blame.currentLine` Extension Setting). Hovering over it shows the commit, with a link that opens it in the
 * Git Map View.
 */
export class LineBlame extends Disposable {
	private readonly dataSource: DataSource;
	private readonly repoManager: RepoManager;
	private readonly logger: Logger;
	private readonly decorationType: vscode.TextEditorDecorationType;
	private enabled: boolean;
	private timeout: NodeJS.Timeout | null = null;
	private requestId: number = 0;
	private decoratedEditor: vscode.TextEditor | null = null;

	/**
	 * Creates the Line Blame.
	 * @param dataSource The Git Map DataSource instance.
	 * @param repoManager The Git Map RepoManager instance.
	 * @param onDidChangeConfiguration The Event emitting when the configuration changes.
	 * @param logger The Git Map Logger instance.
	 */
	constructor(dataSource: DataSource, repoManager: RepoManager, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, logger: Logger) {
		super();
		this.dataSource = dataSource;
		this.repoManager = repoManager;
		this.logger = logger;
		this.enabled = getConfig().blameCurrentLine;
		this.decorationType = vscode.window.createTextEditorDecorationType({
			after: {
				margin: '0 0 0 3em',
				color: new vscode.ThemeColor('editorCodeLens.foreground'),
				fontStyle: 'italic'
			},
			rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen
		});

		this.registerDisposables(
			this.decorationType,
			vscode.window.onDidChangeTextEditorSelection((event) => this.schedule(event.textEditor)),
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				this.clear();
				if (editor) this.schedule(editor);
			}),
			vscode.workspace.onDidChangeTextDocument((event) => {
				// The line numbers may have changed, so the blame is updated once the document stops changing
				if (this.decoratedEditor !== null && this.decoratedEditor.document === event.document) this.schedule(this.decoratedEditor);
			}),
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-map.blame.currentLine')) {
					this.enabled = getConfig().blameCurrentLine;
					this.clear();
					if (this.enabled && vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
				}
			}),
			{ dispose: () => this.cancel() }
		);
		if (this.enabled && vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
	}

	/**
	 * Blame the line the cursor is on in an editor, once the cursor stops moving.
	 * @param editor The editor.
	 */
	private schedule(editor: vscode.TextEditor) {
		if (!this.enabled) return;
		this.cancel();
		if (this.decoratedEditor !== null && this.decoratedEditor.selection.active.line !== editor.selection.active.line) this.clear();
		this.timeout = setTimeout(() => {
			this.timeout = null;
			this.update(editor).catch((error) => this.logger.logError('Unable to blame the current line: ' + error));
		}, BLAME_DELAY);
	}

	/**
	 * Cancel the scheduled blame, and ignore the result of a blame that's in progress.
	 */
	private cancel() {
		if (this.timeout !== null) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.requestId++;
	}

	/**
	 * Remove the blame from the editor it's shown in.
	 */
	private clear() {
		if (this.decoratedEditor !== null) {
			this.decoratedEditor.setDecorations(this.decorationType, []);
			this.decoratedEditor = null;
		}
	}

	/**
	 * Blame the line the cursor is on in an editor, and show the blame at the end of the line.
	 * @param editor The editor.
	 */
	private async update(editor: vscode.TextEditor) {
		const document = editor.document;
		if (!this.enabled || editor !== vscode.window.activeTextEditor || document.uri.scheme !== 'file' || editor.selections.length !== 1) {
			this.clear();
			return;
		}
		const filePath = getPathFromUri(document.uri), repo = this.repoManager.getRepoContainingFile(filePath);
		if (repo === null) {
			this.clear();
			return;
		}
		const line = editor.selection.active.line, requestId = ++this.requestId;
		const blame = await this.dataSource.getLineBlame(repo, filePath.substring(repo.length + 1), line + 1, document.getText());
		if (requestId !== this.requestId || editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) return;
		this.clear();
		if (blame === null) return;

		const end = document.lineAt(line).range.end;
		editor.setDecorations(this.decorationType, [{
			range: new vscode.Range(end, end),
			hoverMessage: getBlameHover(repo, blame),
			renderOptions: { after: { contentText: getBlameText(blame) } }
		}]);
		this.decoratedEditor = editor;
	}
}

/**
 * Get the text of the blame of a line, shown at the end of the line.
 * @param blame The blame of the line.
 * @returns The text.
 */
export function getBlameText(blame: GitLineBlame) {
	if (!blame.committed) return t('You, Uncommitted changes');
	const summary = blame.summary.length > 60 ? blame.summary.substring(0, 59) + '…' : blame.summary;
	return t('{0}, {1} • {2}', blame.author, getRelativeTimeDiff(blame.authorDate), summary);
}

/**
 * Get the hover of the blame of a line: the commit, and a link that opens it in the Git Map View.
 * @param repo The repository containing the line.
 * @param blame The blame of the line.
 * @returns The hover.
 */
function getBlameHover(repo: string, blame: GitLineBlame) {
	const hover = new vscode.MarkdownString(undefined, true);
	if (!blame.committed) {
		hover.appendText(t('This line has uncommitted changes.'));
		return hover;
	}
	const args = encodeURIComponent(JSON.stringify([repo, blame.hash]));
	hover.isTrusted = { enabledCommands: ['git-map.viewCommitInGitMap'] };
	hover.appendMarkdown('$(git-commit) **' + abbrevCommit(blame.hash) + '** · ');
	hover.appendText(blame.author + ' <' + blame.authorEmail + '> · ' + new Date(blame.authorDate * 1000).toLocaleString(getLanguage() === 'zh-cn' ? 'zh-CN' : 'en'));
	hover.appendMarkdown('\n\n');
	hover.appendText(blame.summary);
	hover.appendMarkdown('\n\n[$(git-merge) ' + t('View Commit in Git Map') + '](command:git-map.viewCommitInGitMap?' + args + ')');
	return hover;
}
