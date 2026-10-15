import * as vscode from 'vscode';
import { getConfig } from './config';
import { Logger } from './logger';
import { RepoChangeEvent } from './repoManager';
import { StatusBarItemDisplay } from './types';
import { Disposable } from './utils/disposable';
import { Event } from './utils/event';

/**
 * Manages the Git Graph Status Bar Item, which allows users to open the Git Graph View from the Visual Studio Code Status Bar.
 */
export class StatusBarItem extends Disposable {
	private readonly logger: Logger;
	private readonly statusBarItem: vscode.StatusBarItem;
	private isVisible: boolean = false;
	private numRepos: number = 0;

	/**
	 * Creates the Git Graph Status Bar Item.
	 * @param repoManager The Git Graph RepoManager instance.
	 * @param logger The Git Graph Logger instance.
	 */
	constructor(initialNumRepos: number, onDidChangeRepos: Event<RepoChangeEvent>, onDidChangeConfiguration: Event<vscode.ConfigurationChangeEvent>, logger: Logger) {
		super();
		this.logger = logger;

		const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1);
		statusBarItem.name = 'Git Graph';
		statusBarItem.text = getStatusBarItemText();
		statusBarItem.tooltip = 'View Git Graph';
		statusBarItem.command = 'git-graph.view';
		this.statusBarItem = statusBarItem;

		this.registerDisposables(
			onDidChangeRepos((event) => {
				this.setNumRepos(event.numRepos);
			}),
			onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('git-graph.showStatusBarItem')) {
					this.refresh();
				}
				if (event.affectsConfiguration('git-graph.statusBarItemDisplay')) {
					this.statusBarItem.text = getStatusBarItemText();
				}
			}),
			statusBarItem
		);

		this.setNumRepos(initialNumRepos);
	}

	/**
	 * Sets the number of repositories known to Git Graph, before refreshing the Status Bar Item.
	 * @param numRepos The number of repositories known to Git Graph.
	 */
	private setNumRepos(numRepos: number) {
		this.numRepos = numRepos;
		this.refresh();
	}

	/**
	 * Show or hide the Status Bar Item according to the configured value of `git-graph.showStatusBarItem`, and the number of repositories known to Git Graph.
	 */
	private refresh() {
		const shouldBeVisible = getConfig().showStatusBarItem && this.numRepos > 0;
		if (this.isVisible !== shouldBeVisible) {
			if (shouldBeVisible) {
				this.statusBarItem.show();
				this.logger.log('Showing "Git Graph" Status Bar Item');
			} else {
				this.statusBarItem.hide();
				this.logger.log('Hiding "Git Graph" Status Bar Item');
			}
			this.isVisible = shouldBeVisible;
		}
	}
}

/**
 * Get the text of the Status Bar Item, according to the configured value of `git-graph.statusBarItemDisplay`.
 * @returns The text, using the `git-graph-logo` icon contributed by Git Graph.
 */
function getStatusBarItemText() {
	switch (getConfig().statusBarItemDisplay) {
		case StatusBarItemDisplay.Icon:
			return '$(git-graph-logo)';
		case StatusBarItemDisplay.Text:
			return 'Git Graph';
		default:
			return '$(git-graph-logo) Git Graph';
	}
}
