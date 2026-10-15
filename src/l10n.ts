import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getConfig } from './config';
import { L10nBundle } from './types';

export type Language = 'en' | 'zh-cn';

const L10N_DIRECTORY = path.join(__dirname, '..', 'l10n');
const loadedBundles: { [language: string]: L10nBundle | null } = {};

/**
 * Get the language that Git Graph displays messages in, according to the `git-graph.language` Extension Setting, and the display language of Visual Studio Code.
 * @returns The language.
 */
export function getLanguage(): Language {
	const language = getConfig().language;
	if (language === 'English') return 'en';
	if (language === 'Simplified Chinese') return 'zh-cn';
	return /^zh(-(cn|sg|hans.*))?$/i.test(vscode.env.language || '') ? 'zh-cn' : 'en';
}

/**
 * Get the translations of the messages displayed by Git Graph, for the language it displays messages in.
 * @returns The translations, or NULL if messages are displayed in English.
 */
export function getL10nBundle(): L10nBundle | null {
	const language = getLanguage();
	if (language === 'en') return null;
	if (typeof loadedBundles[language] === 'undefined') {
		try {
			loadedBundles[language] = JSON.parse(fs.readFileSync(path.join(L10N_DIRECTORY, 'bundle.l10n.' + language + '.json'), 'utf8'));
		} catch (_) {
			loadedBundles[language] = null;
		}
	}
	return loadedBundles[language];
}

/**
 * Translate a message into the language that Git Graph displays messages in.
 * @param message The message (in English), which is also the key of its translations. It can contain placeholders ({0}, {1}, etc.) for the arguments.
 * @param args The arguments substituted into the message's placeholders.
 * @returns The translated message.
 */
export function t(message: string, ...args: (string | number)[]) {
	const bundle = getL10nBundle();
	return formatMessage(bundle !== null && typeof bundle[message] === 'string' ? bundle[message] : message, args);
}

/**
 * Substitute arguments into the placeholders ({0}, {1}, etc.) of a message.
 * @param message The message.
 * @param args The arguments.
 * @returns The message with the arguments substituted into it.
 */
function formatMessage(message: string, args: ReadonlyArray<string | number>) {
	return args.length === 0 ? message : message.replace(/\{(\d+)\}/g, (placeholder, index) => index < args.length ? String(args[parseInt(index)]) : placeholder);
}
