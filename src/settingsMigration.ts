import * as vscode from 'vscode';
import { t } from './l10n';
import { Logger } from './logger';

/**
 * The section of Git Map's Extension Settings before version 2.1.0, which is shared with the original Git Graph extension (that still uses it).
 */
const OLD_SECTION = 'git-graph';

/**
 * The section of Git Map's Extension Settings.
 */
const NEW_SECTION = 'git-map';

/**
 * The identifier of the original Git Graph extension.
 */
const GIT_GRAPH_EXTENSION_ID = 'mhutchie.git-graph';

/**
 * The key of the global & workspace state recording that the settings of the user / workspace have been migrated (so that they're only
 * migrated once, and a setting the user resets later isn't copied again).
 */
const MIGRATED_STATE_KEY = 'settingsMigratedToGitMap';

/**
 * The names that Extension Settings had before they were renamed, which Config still reads if the current name isn't set (see
 * `Config.getRenamedExtensionSetting`). They're contributed as deprecated settings, so their values are copied to the current names.
 */
const LEGACY_NAMES: { readonly [name: string]: string } = {
	'commitDetailsView.autoCenter': 'autoCenterCommitDetailsView',
	'commitDetailsView.fileView.fileTree.compactFolders': 'commitDetailsViewFileTreeCompactFolders',
	'commitDetailsView.fileView.type': 'defaultFileViewType',
	'commitDetailsView.location': 'commitDetailsViewLocation',
	'date.format': 'dateFormat',
	'date.type': 'dateType',
	'graph.colours': 'graphColours',
	'graph.style': 'graphStyle',
	'openNewTabEditorGroup': 'openDiffTabLocation',
	'referenceLabels.alignment': 'referenceLabelAlignment',
	'referenceLabels.combineLocalAndRemoteBranchLabels': 'combineLocalAndRemoteBranchLabels',
	'repository.commits.fetchAvatars': 'fetchAvatars',
	'repository.commits.initialLoad': 'initialLoadCommits',
	'repository.commits.loadMore': 'loadMoreCommits',
	'repository.commits.loadMoreAutomatically': 'loadMoreCommitsAutomatically',
	'repository.commits.mute.commitsThatAreNotAncestorsOfHead': 'muteCommitsThatAreNotAncestorsOfHead',
	'repository.commits.mute.mergeCommits': 'muteMergeCommits',
	'repository.commits.order': 'commitOrdering',
	'repository.commits.showSignatureStatus': 'showSignatureStatus',
	'repository.fetchAndPrune': 'fetchAndPrune',
	'repository.includeCommitsMentionedByReflogs': 'includeCommitsMentionedByReflogs',
	'repository.onLoad.scrollToHead': 'openRepoToHead',
	'repository.onLoad.showCheckedOutBranch': 'showCurrentBranchByDefault',
	'repository.onlyFollowFirstParent': 'onlyFollowFirstParent',
	'repository.showCommitsOnlyReferencedByTags': 'showCommitsOnlyReferencedByTags',
	'repository.showTags': 'showTags',
	'repository.showUncommittedChanges': 'showUncommittedChanges',
	'repository.showUntrackedFiles': 'showUntrackedFiles',
	'repository.useMailmap': 'useMailmap'
};

/**
 * Where a value of an Extension Setting is set: the user settings, the workspace settings, or the settings of a workspace folder (of a
 * multi-root workspace).
 */
interface SettingsScope {
	readonly target: vscode.ConfigurationTarget;
	readonly folder: vscode.Uri | null;
}

/**
 * A value of an Extension Setting in the old section.
 */
export interface OldSettingValue extends SettingsScope {
	readonly name: string; // The name of the setting (without the section)
}

/**
 * The result of migrating the Extension Settings.
 */
export interface SettingsMigrationResult {
	readonly copied: ReadonlyArray<string>; // The settings that were copied to the new section (e.g. "git-map.graph.style (User)")
	readonly oldValues: ReadonlyArray<OldSettingValue>; // The values in the old section, in the scopes that were migrated (which can be removed)
	readonly errors: ReadonlyArray<string>;
}

/**
 * Migrate the Extension Settings from the old section (`git-graph.*`) to the new section (`git-map.*`): the values the user has set in the
 * old section (for the current or a legacy name of a setting) are copied to the new section, in the same scope, unless the setting is
 * already set there. The user settings are migrated once, and the settings of each workspace are migrated once. The values in the old
 * section are kept (the original Git Graph extension uses them), and can be removed with `removeOldSettings`.
 * @param globalState The global state of the extension.
 * @param workspaceState The workspace state of the extension.
 * @param packageJson The extension's package.json.
 * @param logger The Git Map Logger instance.
 * @returns The result of the migration.
 */
export async function migrateSettings(globalState: vscode.Memento, workspaceState: vscode.Memento, packageJson: any, logger: Logger): Promise<SettingsMigrationResult> {
	const properties: { [key: string]: { scope?: string, deprecationMessage?: string, markdownDeprecationMessage?: string } } = packageJson.contributes.configuration.properties;
	const isDeprecated = (key: string) => typeof properties[key].deprecationMessage === 'string' || typeof properties[key].markdownDeprecationMessage === 'string';
	const settings = Object.keys(properties).filter((key) => key.startsWith(NEW_SECTION + '.') && !isDeprecated(key)).map((key) => ({
		name: key.substring(NEW_SECTION.length + 1),
		resource: properties[key].scope === 'resource'
	}));

	const states: { state: vscode.Memento, scopes: SettingsScope[] }[] = [];
	if (!globalState.get<boolean>(MIGRATED_STATE_KEY, false)) {
		states.push({ state: globalState, scopes: [{ target: vscode.ConfigurationTarget.Global, folder: null }] });
	}
	const folders = vscode.workspace.workspaceFolders || [];
	if (folders.length > 0 && !workspaceState.get<boolean>(MIGRATED_STATE_KEY, false)) {
		// The settings of the folders of a multi-root workspace are only applied for resource settings
		const folderScopes = vscode.workspace.workspaceFile !== undefined ? folders.map((folder) => ({ target: vscode.ConfigurationTarget.WorkspaceFolder, folder: folder.uri })) : [];
		states.push({ state: workspaceState, scopes: [{ target: vscode.ConfigurationTarget.Workspace, folder: null }, ...folderScopes] });
	}

	const copied: string[] = [], oldValues: OldSettingValue[] = [], errors: string[] = [];
	for (const { state, scopes } of states) {
		let failed = false;
		for (const scope of scopes) {
			const oldConfig = vscode.workspace.getConfiguration(OLD_SECTION, scope.folder || undefined);
			const newConfig = vscode.workspace.getConfiguration(NEW_SECTION, scope.folder || undefined);
			for (const setting of settings) {
				if (scope.target === vscode.ConfigurationTarget.WorkspaceFolder && !setting.resource) continue;

				// The current name takes precedence over the legacy name (as when Config reads them)
				const names = [setting.name].concat(typeof LEGACY_NAMES[setting.name] === 'string' ? [LEGACY_NAMES[setting.name]] : []);
				const setNames = names.filter((name) => typeof getValue(oldConfig, name, scope.target) !== 'undefined');
				setNames.forEach((name) => oldValues.push({ name: name, target: scope.target, folder: scope.folder }));
				if (setNames.length === 0 || typeof getValue(newConfig, setting.name, scope.target) !== 'undefined') continue;

				const description = NEW_SECTION + '.' + setting.name + ' (' + getScopeName(scope) + ')';
				try {
					await newConfig.update(setting.name, getValue(oldConfig, setNames[0], scope.target), scope.target);
					copied.push(description);
					logger.log('Copied the Extension Setting "' + OLD_SECTION + '.' + setNames[0] + '" to "' + description + '"');
				} catch (error) {
					failed = true;
					errors.push(description + ': ' + error);
					logger.logError('Unable to copy the Extension Setting "' + OLD_SECTION + '.' + setNames[0] + '" to "' + description + '": ' + error);
				}
			}
		}
		// If a setting couldn't be copied (e.g. the settings file contains errors), the migration is tried again the next time Git Map starts
		if (!failed) await state.update(MIGRATED_STATE_KEY, true);
	}
	return { copied: copied, oldValues: oldValues, errors: errors };
}

/**
 * Remove values of Extension Settings in the old section (`git-graph.*`).
 * @param oldValues The values to remove.
 * @param logger The Git Map Logger instance.
 * @returns The errors that occurred.
 */
export async function removeOldSettings(oldValues: ReadonlyArray<OldSettingValue>, logger: Logger) {
	const errors: string[] = [];
	for (const value of oldValues) {
		const description = OLD_SECTION + '.' + value.name + ' (' + getScopeName(value) + ')';
		try {
			await vscode.workspace.getConfiguration(OLD_SECTION, value.folder || undefined).update(value.name, undefined, value.target);
			logger.log('Removed the Extension Setting "' + description + '"');
		} catch (error) {
			errors.push(description + ': ' + error);
			logger.logError('Unable to remove the Extension Setting "' + description + '": ' + error);
		}
	}
	return errors;
}

/**
 * Tell the user that their Extension Settings were copied to the new section (if any were). Unless the original Git Graph extension is
 * installed (which uses them), the settings in the old section can be removed.
 * @param result The result of the migration.
 * @param logger The Git Map Logger instance.
 */
export function showSettingsMigrationMessage(result: SettingsMigrationResult, logger: Logger) {
	if (result.errors.length > 0) {
		vscode.window.showErrorMessage(t('Unable to copy some of your "git-graph.*" Extension Settings to their new names ("git-map.*"): {0}', result.errors.join(', ')));
	}
	if (result.copied.length === 0) return;

	const message = t('Git Map\'s Extension Settings are now named "git-map.*" instead of "git-graph.*". Your settings were copied to their new names ({0}).', result.copied.length);
	if (vscode.extensions.getExtension(GIT_GRAPH_EXTENSION_ID) !== undefined) {
		vscode.window.showInformationMessage(message + ' ' + t('The "git-graph.*" settings are kept, as the Git Graph extension uses them.'));
		return;
	}
	const removeAction = t('Remove the "git-graph.*" Settings');
	vscode.window.showInformationMessage(message, removeAction).then((action) => {
		if (action !== removeAction) return;
		removeOldSettings(result.oldValues, logger).then((errors) => {
			if (errors.length > 0) vscode.window.showErrorMessage(t('Unable to remove some of the "git-graph.*" Extension Settings: {0}', errors.join(', ')));
		});
	});
}

/**
 * Get the value of an Extension Setting in a scope.
 * @param config The configuration of the section of the setting.
 * @param name The name of the setting (without the section).
 * @param target The scope.
 * @returns The value, or `undefined` if the setting isn't set in the scope.
 */
function getValue(config: vscode.WorkspaceConfiguration, name: string, target: vscode.ConfigurationTarget): unknown {
	const values = config.inspect(name);
	if (typeof values === 'undefined') return undefined;
	return target === vscode.ConfigurationTarget.Global
		? values.globalValue
		: target === vscode.ConfigurationTarget.Workspace
			? values.workspaceValue
			: values.workspaceFolderValue;
}

/**
 * Get the name of a scope, for messages.
 * @param scope The scope.
 * @returns The name.
 */
function getScopeName(scope: SettingsScope) {
	return scope.target === vscode.ConfigurationTarget.Global
		? 'User'
		: scope.target === vscode.ConfigurationTarget.Workspace
			? 'Workspace'
			: 'Folder ' + scope.folder!.fsPath;
}
