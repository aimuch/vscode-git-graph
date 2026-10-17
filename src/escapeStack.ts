import * as vscode from 'vscode';
import { Disposable } from './utils/disposable';

/**
 * Something shown by Git Map that Escape closes: the Line History drawer or inline window, or the File Blame of a file.
 */
interface EscapeEntry {
	readonly id: string;
	readonly isOpen: () => boolean; // Is it shown (and relevant to the active editor)
	readonly close: () => void;
}

/**
 * Closes what Git Map showed most recently when Escape is pressed in an editor (or the Line History drawer), returning to how it was
 * before: the Line History drawer or inline window, or the File Blame of the file. The `git-map:escapable` context key is set while there's
 * something to close, so Escape keeps its other uses in the editor (the keybinding also excludes selections, widgets & suggestions).
 */
export class EscapeStack extends Disposable {
	private static instance: EscapeStack | null = null;
	private entries: EscapeEntry[] = [];

	/**
	 * Creates the Escape Stack.
	 */
	constructor() {
		super();
		EscapeStack.instance = this;
		this.registerDisposables(
			vscode.commands.registerCommand('git-map.escape', () => this.escape()),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
			{
				dispose: () => {
					if (EscapeStack.instance === this) EscapeStack.instance = null;
				}
			}
		);
		this.updateContext();
	}

	/**
	 * Record that something has been shown, which Escape closes (it's moved to the top, if it's already recorded).
	 * @param id The identifier of what was shown.
	 * @param isOpen Is it shown (and relevant to the active editor).
	 * @param close Close it.
	 */
	public static push(id: string, isOpen: () => boolean, close: () => void) {
		const stack = EscapeStack.instance;
		if (stack === null) return;
		stack.entries = stack.entries.filter((entry) => entry.id !== id);
		stack.entries.push({ id: id, isOpen: isOpen, close: close });
		stack.updateContext();
	}

	/**
	 * Record that something has been closed (in another way than Escape).
	 * @param id The identifier of what was closed.
	 */
	public static remove(id: string) {
		const stack = EscapeStack.instance;
		if (stack === null) return;
		stack.entries = stack.entries.filter((entry) => entry.id !== id);
		stack.updateContext();
	}

	/**
	 * Update whether there's something to close (when the active editor changes, as the File Blame only closes for its file).
	 */
	public static update() {
		if (EscapeStack.instance !== null) EscapeStack.instance.updateContext();
	}

	/**
	 * Close what was shown most recently (that's still shown).
	 */
	private escape() {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (!entry.isOpen()) continue;
			this.entries.splice(i, 1);
			entry.close();
			break;
		}
		this.updateContext();
	}

	/**
	 * Set the context key used by the keybinding of Escape.
	 */
	private updateContext() {
		vscode.commands.executeCommand('setContext', 'git-map:escapable', this.entries.some((entry) => entry.isOpen()));
	}
}
