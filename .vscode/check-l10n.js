/**
 * Checks that every message translated with t('...') in ./src and ./web has a translation in each
 * ./l10n/bundle.l10n.<language>.json file, and lists translations that are no longer used. Also checks that every
 * %key% placeholder in package.json has a description in each package.nls[.<language>].json file.
 *
 * Usage: node ./.vscode/check-l10n.js [--list]
 *  --list: Print the messages that are missing translations as JSON (to add them to a bundle).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRECTORIES = ['src', 'web'];
const L10N_DIRECTORY = path.join(ROOT, 'l10n');

// Messages that are translated with a key that isn't a string literal (e.g. t(value)), which therefore can't be found in the source
const DYNAMIC_MESSAGES = [
	// UNABLE_TO_FIND_GIT_MSG (src/utils.ts)
	'Unable to find a Git executable. Either: Set the Visual Studio Code Setting "git.path" to the path and filename of an existing Git executable, or install Git and restart Visual Studio Code.',
	// GIT_FILE_CHANGE_TYPES & GIT_SIGNATURE_STATUS_DESCRIPTIONS (web/utils.ts)
	'Added', 'Modified', 'Deleted', 'Renamed', 'Untracked',
	'Valid Signature', 'Good Signature with Unknown Validity', 'Good Signature that has Expired', 'Good Signature made by an Expired Key', 'Good Signature made by a Revoked Key', 'Signature could not be checked', 'Bad Signature',
	// MONTHS (web/utils.ts)
	'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
	// Relative dates (src/utils.ts & web/utils.ts)
	...['second', 'minute', 'hour', 'day', 'week', 'month', 'year'].flatMap((unit) => ['{0} ' + unit + ' ago', '{0} ' + unit + 's ago']),
	// Dropdown types (web/main.ts)
	'Repos', 'Branches', 'Authors',
	// MergeActionOn & RebaseActionOn (src/types.ts)
	'Branch', 'Remote-tracking Branch', 'Commit',
	// Graph Colour Presets (src/config.ts)
	'Default', 'Pastel', 'Vivid', 'High Contrast', 'Colour Blind Safe', 'Tokyo Subway'
];

function listSourceFiles(directory) {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) return listSourceFiles(entryPath);
		return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [entryPath] : [];
	});
}

function unescapeLiteral(literal) {
	return literal.replace(/\\(.)/g, (_, char) => char === 'n' ? '\n' : char);
}

function findMessages() {
	const messages = new Set(DYNAMIC_MESSAGES);
	const pattern = /\bt\(\s*'((?:[^'\\\n]|\\.)*)'\s*[,)]/g; // Only complete literals (not the start of a concatenation)
	SOURCE_DIRECTORIES.flatMap((directory) => listSourceFiles(path.join(ROOT, directory))).forEach((file) => {
		const source = fs.readFileSync(file, 'utf8');
		let match;
		while ((match = pattern.exec(source)) !== null) {
			messages.add(unescapeLiteral(match[1]));
		}
	});
	return messages;
}

const messages = findMessages();
const bundles = fs.readdirSync(L10N_DIRECTORY).filter((file) => /^bundle\.l10n\.[a-z-]+\.json$/.test(file));
let failed = false;

bundles.forEach((file) => {
	const bundle = JSON.parse(fs.readFileSync(path.join(L10N_DIRECTORY, file), 'utf8'));
	const missing = Array.from(messages).filter((message) => typeof bundle[message] !== 'string');
	const unused = Object.keys(bundle).filter((message) => !messages.has(message));
	const placeholderMismatches = Object.keys(bundle).filter((message) => {
		const placeholders = (text) => (text.match(/\{\d+\}/g) || []).sort().join(',');
		// A translation may omit an English-only placeholder (e.g. a plural "s"), but must not reference one that doesn't exist
		return messages.has(message) && placeholders(bundle[message]).split(',').some((placeholder) => placeholder !== '' && !placeholders(message).split(',').includes(placeholder));
	});

	if (process.argv.includes('--list')) {
		console.log(JSON.stringify(missing, null, '\t'));
	}
	console.log(file + ': ' + (messages.size - missing.length) + '/' + messages.size + ' messages translated' + (unused.length > 0 ? ', ' + unused.length + ' unused' : ''));
	if (missing.length > 0 && !process.argv.includes('--list')) {
		console.log('  Missing translations:\n' + missing.map((message) => '    ' + JSON.stringify(message)).join('\n'));
		failed = true;
	}
	if (placeholderMismatches.length > 0) {
		console.log('  Translations referencing placeholders that the message doesn\'t have:\n' + placeholderMismatches.map((message) => '    ' + JSON.stringify(message)).join('\n'));
		failed = true;
	}
	if (unused.length > 0) {
		console.log('  Unused translations:\n' + unused.map((message) => '    ' + JSON.stringify(message)).join('\n'));
	}
});

// The descriptions of the contributions in package.json (%key% placeholders) must be in each package.nls[.<language>].json file
const placeholders = Array.from(new Set((fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').match(/"%[^"%]+%"/g) || []).map((key) => key.slice(2, -2))));
fs.readdirSync(ROOT).filter((file) => /^package\.nls(\.[a-z-]+)?\.json$/.test(file)).forEach((file) => {
	const nls = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
	const missing = placeholders.filter((key) => typeof nls[key] !== 'string');
	const unused = Object.keys(nls).filter((key) => !placeholders.includes(key));
	console.log(file + ': ' + (placeholders.length - missing.length) + '/' + placeholders.length + ' contribution descriptions' + (unused.length > 0 ? ', ' + unused.length + ' unused' : ''));
	if (missing.length > 0) {
		console.log('  Missing descriptions:\n' + missing.map((key) => '    ' + key).join('\n'));
		failed = true;
	}
	if (unused.length > 0) {
		console.log('  Unused descriptions:\n' + unused.map((key) => '    ' + key).join('\n'));
	}
});

process.exit(failed ? 1 : 0);
