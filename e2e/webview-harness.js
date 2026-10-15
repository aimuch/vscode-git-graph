/**
 * Webview UI Harness - Injected (by ./suite.js) into a copy of the Git Graph View's HTML, and run in a real Visual
 * Studio Code Webview. It replaces the Webview's messaging API with a fake back-end serving fixture data, drives the
 * UI with DOM events (as a user would), and posts the result of each check back to the Extension Host.
 */
(function () {
	'use strict';
	const realApi = acquireVsCodeApi();
	const requests = [];
	const REPO = '/e2e/harness-repo';
	const NOW = Math.round(Date.now() / 1000);
	const ISSUE_URL = 'gitgraph-e2e://issue/$1';
	const hash = (n) => n.toString(16).padStart(40, '0');
	const HEAD_INDEX = 19;

	/* Fixture Data */

	const makeCommits = (count) => {
		const commits = [];
		for (let i = 0; i < count; i++) {
			commits.push({
				hash: hash(i + 1),
				parents: i < count - 1 ? [hash(i + 2)] : [],
				author: 'E2E Author',
				email: 'author@example.com',
				date: NOW - i * 3600,
				message: i === 0 ? 'Fix #12 and rename files' : (i % 2 === 0 ? 'Resolve #' + (100 + i) : 'Commit ' + i),
				heads: i === 0 ? ['feature'] : i === HEAD_INDEX ? ['main'] : [],
				tags: [],
				remotes: [],
				stash: null
			});
		}
		return commits;
	};

	const respond = (msg) => {
		switch (msg.command) {
			case 'loadRepoInfo':
				return { command: 'loadRepoInfo', refreshId: msg.refreshId, branches: ['feature', 'main'], head: 'main', remotes: ['origin'], stashes: [], isRepo: true, error: null };
			case 'loadCommits':
				// HEAD is the 20th commit, which isn't included in the first load of 10 commits
				return msg.maxCommits <= 10
					? { command: 'loadCommits', refreshId: msg.refreshId, commits: makeCommits(10), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: true, onlyFollowFirstParent: msg.onlyFollowFirstParent, error: null }
					: { command: 'loadCommits', refreshId: msg.refreshId, commits: makeCommits(25), head: hash(HEAD_INDEX + 1), tags: [], moreCommitsAvailable: false, onlyFollowFirstParent: msg.onlyFollowFirstParent, error: null };
			case 'loadConfig':
				return {
					command: 'loadConfig', repo: msg.repo, error: null,
					config: {
						branches: {}, diffTool: null, guiDiffTool: null, pushDefault: null,
						remotes: [{ name: 'origin', url: 'git@github.com:e2e-owner/e2e-repo.git', pushUrl: null }],
						user: { name: { local: null, global: 'E2E Author' }, email: { local: null, global: 'author@example.com' } }
					}
				};
			case 'commitDetails':
				return {
					command: 'commitDetails', avatar: null, codeReview: null, refresh: msg.refresh, error: null,
					commitDetails: {
						hash: msg.commitHash, parents: [hash(2)],
						author: 'E2E Author', authorEmail: 'author@example.com', authorDate: NOW,
						committer: 'E2E Author', committerEmail: 'author@example.com', committerDate: NOW,
						signature: null, body: 'Fix #12 and rename files',
						fileChanges: [
							{ oldFilePath: 'src/old-name.ts', newFilePath: 'src/new-name.ts', type: 'R', additions: 1, deletions: 1 },
							{ oldFilePath: 'lib/moved.ts', newFilePath: 'src/moved.ts', type: 'R', additions: 0, deletions: 0 },
							{ oldFilePath: 'README.md', newFilePath: 'README.md', type: 'M', additions: 2, deletions: 1 }
						]
					}
				};
			case 'openExternalUrl':
			case 'setGlobalViewState':
			case 'setWorkspaceViewState':
				return { command: msg.command, error: null };
			default:
				return null;
		}
	};

	const fakeApi = {
		postMessage: (msg) => {
			requests.push(msg);
			const response = respond(msg);
			if (response !== null) setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: response })), 0);
		},
		getState: () => null,
		setState: () => { }
	};
	globalThis.acquireVsCodeApi = () => fakeApi;

	// Load the fixture repository, with Issue Linking configured to use a custom URL scheme
	const repoState = Object.assign({}, initialState.repos[Object.keys(initialState.repos)[0]], { issueLinkingConfig: { issue: '#(\\d+)', url: ISSUE_URL }, name: null });
	initialState.repos = { [REPO]: repoState };
	initialState.loadViewTo = { repo: REPO };
	initialState.lastActiveRepo = REPO;
	initialState.config.fetchAvatars = false;
	initialState.config.initialLoadCommits = 10;
	initialState.config.loadMoreCommits = 15;
	initialState.config.onRepoLoad = Object.assign({}, initialState.config.onRepoLoad, { scrollToHead: false });

	/* Helpers */

	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (description, condition, timeout = 5000) => {
		const start = Date.now();
		while (Date.now() - start < timeout) {
			const value = condition();
			if (value) return value;
			await sleep(25);
		}
		throw new Error('Timed out waiting for ' + description);
	};
	const assert = (condition, message) => {
		if (!condition) throw new Error(message);
	};
	const key = (target, k, modifiers) => {
		const event = new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, modifiers || {}));
		target.dispatchEvent(event);
		return event;
	};
	const mouse = (target, type, init) => {
		const bounds = target.getBoundingClientRect();
		const event = new MouseEvent(type, Object.assign({ bubbles: true, cancelable: true, clientX: Math.round(bounds.left + Math.min(bounds.width / 2, 50)), clientY: Math.round(bounds.top + bounds.height / 2) }, init || {}));
		target.dispatchEvent(event);
		return event;
	};
	const requestsOf = (command) => requests.filter((msg) => msg.command === command);
	const commitRow = (index) => document.querySelector('#commitTable tr.commit[data-id="' + index + '"]');
	const isMac = navigator.platform.toUpperCase().indexOf('MAC') > -1;
	const ctrl = isMac ? { metaKey: true } : { ctrlKey: true };
	const results = [];
	const check = async (id, title, fn) => {
		try {
			results.push({ id: id, title: title, pass: true, details: (await fn()) || '' });
		} catch (err) {
			results.push({ id: id, title: title, pass: false, details: err && err.stack ? err.stack : String(err) });
		}
	};

	/* Checks */

	const run = async () => {
		const keybindings = initialState.config.keybindings;
		await waitFor('the commits to be rendered', () => document.querySelectorAll('#commitTable tr.commit').length === 10, 10000);

		await check('#857', '"Scroll to HEAD" loads more commits until HEAD is loaded', async () => {
			const loads = requestsOf('loadCommits').length;
			key(document.body, keybindings.scrollToHead, ctrl);
			await waitFor('more commits to be requested', () => requestsOf('loadCommits').length > loads);
			await waitFor('the HEAD commit to be scrolled to', () => commitRow(HEAD_INDEX) !== null && commitRow(HEAD_INDEX).classList.contains('flash'));
			return 'Requested maxCommits ' + requestsOf('loadCommits').map((msg) => msg.maxCommits).join(' → ');
		});

		await check('#892', 'The second keypress of a keybinding chord (e.g. Ctrl+K Ctrl+H) is left to Visual Studio Code', async () => {
			key(document.body, 'k', ctrl);
			const chordEvent = key(document.body, keybindings.find, ctrl);
			assert(!chordEvent.defaultPrevented, 'Git Graph handled the second keypress of the chord');
			assert(!document.querySelector('.findWidget').classList.contains('active'), 'The Find Widget was opened by the second keypress of the chord');
			const event = key(document.body, keybindings.find, ctrl);
			assert(event.defaultPrevented, 'Git Graph didn\'t handle its own keybinding outside of a chord');
			await waitFor('the Find Widget to open', () => document.querySelector('.findWidget').classList.contains('active'));
			key(document.getElementById('findInput'), 'Escape');
			await waitFor('the Find Widget to close', () => !document.querySelector('.findWidget').classList.contains('active'));
		});

		await check('#928', 'Tooltips are shown for elements with a title (e.g. the (i) icons)', async () => {
			const findBtn = document.getElementById('findBtn');
			let tooltip = null;
			for (let attempt = 1; attempt <= 3 && tooltip === null; attempt++) {
				// Retried, as real mouse / focus events (the Visual Studio Code window is on screen) can hide a pending tooltip
				mouse(findBtn, 'mouseover');
				assert(!findBtn.hasAttribute('title'), 'The title attribute should be removed while hovering, so the native tooltip isn\'t also shown');
				tooltip = await waitFor('the tooltip to be shown', () => document.getElementById('titleTooltip'), 1500).catch(() => null);
			}
			assert(tooltip !== null, 'The tooltip wasn\'t shown');
			assert(tooltip.textContent === 'Find', 'Unexpected tooltip: ' + tooltip.textContent);
			mouse(document.getElementById('commitTable'), 'mouseover');
			assert(document.getElementById('titleTooltip') === null, 'The tooltip wasn\'t hidden');
			assert(findBtn.getAttribute('title') === 'Find', 'The title attribute wasn\'t restored');
		});

		await check('#852', 'The mouse back / forward buttons navigate the editor history', async () => {
			mouse(document.getElementById('view'), 'mouseup', { button: 3 });
			mouse(document.getElementById('view'), 'mouseup', { button: 4 });
			const navigations = requestsOf('navigateEditorHistory').map((msg) => msg.forward);
			assert(navigations.length === 2 && navigations[0] === false && navigations[1] === true, 'Unexpected navigation requests: ' + JSON.stringify(navigations));
		});

		// Open the Commit Details View of the first commit
		mouse(commitRow(0), 'click');
		await waitFor('the Commit Details View to load', () => document.querySelector('#cdv .fileTreeFileRecord'));

		await check('#723', 'Renamed files show their original name in the Commit Details View', async () => {
			const labels = Array.from(document.querySelectorAll('#cdv .gitFileRenamedFrom')).map((elem) => elem.textContent);
			assert(labels.length === 2 && labels.includes('← old-name.ts') && labels.includes('← lib/moved.ts'), 'Unexpected labels: ' + JSON.stringify(labels));
			return labels.join(', ');
		});

		await check('#792', 'Issue links using a custom URL scheme are opened (via the extension)', async () => {
			const link = await waitFor('the issue link', () => Array.from(document.querySelectorAll('#cdv a.externalUrl')).find((elem) => elem.getAttribute('href').startsWith('gitgraph-e2e:')));
			// If Git Graph doesn't handle the click, prevent the Webview from navigating to the link (which would unload this harness)
			let reachedSafetyNet = false, preventedBeforeSafetyNet = false;
			const safetyNet = (e) => {
				reachedSafetyNet = true;
				preventedBeforeSafetyNet = e.defaultPrevented;
				e.preventDefault();
			};
			window.addEventListener('click', safetyNet);
			const event = mouse(link, 'click');
			window.removeEventListener('click', safetyNet);
			assert(reachedSafetyNet ? preventedBeforeSafetyNet : event.defaultPrevented, 'The click wasn\'t handled');
			const opened = requestsOf('openExternalUrl').map((msg) => msg.url);
			assert(opened.length === 1 && opened[0] === 'gitgraph-e2e://issue/12', 'Unexpected URLs opened: ' + JSON.stringify(opened));
			return 'Opened ' + opened[0];
		});

		await check('#864', 'The Menu key / Shift+F10 opens the context menu of the commit selected with the keyboard', async () => {
			const view = document.getElementById('view');
			view.focus();
			mouse(view, 'contextmenu', { button: 0 });
			const menu = await waitFor('the context menu to open', () => document.querySelector('.contextMenu'));
			assert(menu.textContent.includes('Create Branch'), 'Unexpected context menu: ' + menu.textContent);
			assert(commitRow(0).classList.contains('contextMenuActive'), 'The context menu isn\'t for the selected commit');
			key(document.body, 'Escape');
			await waitFor('the context menu to close', () => document.querySelector('.contextMenu') === null);
		});

		// Open the "Create Branch" dialog from the context menu of a commit
		mouse(commitRow(1), 'contextmenu', { button: 2 });
		const createBranchItem = await waitFor('the "Create Branch..." action', () => Array.from(document.querySelectorAll('.contextMenu .contextMenuItem')).find((elem) => elem.textContent.startsWith('Create Branch')));
		mouse(createBranchItem, 'click');
		const dialogElem = await waitFor('the dialog to open', () => document.querySelector('.dialog'));

		await check('#856', 'Pasting a branch name with the mouse enables the "Create Branch" button', async () => {
			assert(dialogElem.classList.contains('noInput'), 'The dialog should initially indicate that no name was entered');
			const input = document.getElementById('dialogInput0');
			input.value = 'feature/pasted-with-the-mouse';
			input.dispatchEvent(new Event('input', { bubbles: true })); // Pasting with the context menu triggers an input event (no key events)
			assert(!dialogElem.classList.contains('noInput'), 'The "Create Branch" button is still disabled');
		});

		await check('#652', 'The dialog buttons can be focused with Tab (after the inputs), and activated with Enter', async () => {
			const inputTabIndexes = Array.from(dialogElem.querySelectorAll('input, .customSelectCurrent')).map((elem) => elem.tabIndex);
			const actionButton = document.getElementById('dialogAction'), cancelButton = document.getElementById('dialogSecondaryAction');
			assert(actionButton.tabIndex > Math.max.apply(null, inputTabIndexes) && cancelButton.tabIndex > actionButton.tabIndex, 'Unexpected tab order: inputs ' + JSON.stringify(inputTabIndexes) + ', buttons ' + actionButton.tabIndex + ', ' + cancelButton.tabIndex);
			cancelButton.focus();
			assert(document.activeElement === cancelButton, 'The Cancel button can\'t be focused');
			key(cancelButton, 'Enter');
			await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			assert(requestsOf('createBranch').length === 0, 'Enter on the Cancel button created the branch');
			return 'Tab order: inputs ' + inputTabIndexes.join(', ') + ' → buttons ' + actionButton.tabIndex + ', ' + cancelButton.tabIndex;
		});

		await check('#707', 'Adding Issue Linking prefills the Issue URL of the repository\'s GitHub remote (not an example URL)', async () => {
			if (document.querySelector('.dialog') !== null) {
				key(document.body, 'Escape'); // Close any dialog left open by a previous (failed) check
				await waitFor('the dialog to close', () => document.querySelector('.dialog') === null);
			}
			const loadedCommits = document.querySelectorAll('#commitTable tr.commit').length;
			mouse(document.getElementById('settingsBtn'), 'click');
			mouse(await waitFor('the "Remove" Issue Linking button', () => document.getElementById('removeIssueLinking')), 'click');
			mouse(await waitFor('the confirmation', () => document.getElementById('dialogAction')), 'click');
			// Removing the Issue Linking hard refreshes the view, wait for the commits to be reloaded (they're used to detect the Issue Regex)
			await waitFor('the commits to be reloaded', () => document.querySelectorAll('#commitTable tr.commit').length === loadedCommits);
			const addButton = await waitFor('the "Add Issue Linking" button', () => {
				const elem = document.getElementById('editIssueLinking');
				return elem !== null && elem.classList.contains('addBtn') ? elem : null;
			});
			mouse(addButton, 'click');
			const issueUrlInput = await waitFor('the Issue Linking dialog', () => document.getElementById('dialogInput1'));
			const issueRegex = document.getElementById('dialogInput0').value;
			assert(issueRegex === '#(\\d+)', 'Unexpected Issue Regex: ' + issueRegex);
			assert(issueUrlInput.value === 'https://github.com/e2e-owner/e2e-repo/issues/$1', 'Unexpected Issue URL: ' + issueUrlInput.value);
			assert(!document.querySelector('.dialog').textContent.includes('mhutchie'), 'The dialog still refers to the original author\'s repository');
			key(document.body, 'Escape');
			return 'Prefilled: ' + issueRegex + ' → ' + issueUrlInput.value;
		});
	};

	window.addEventListener('load', () => {
		setTimeout(() => {
			run().catch((err) => {
				results.push({ id: 'webview-harness', title: 'The Webview UI harness ran', pass: false, details: err && err.stack ? err.stack : String(err) });
			}).then(() => {
				realApi.postMessage({ command: 'e2eResults', results: results });
			});
		}, 0);
	});
})();
