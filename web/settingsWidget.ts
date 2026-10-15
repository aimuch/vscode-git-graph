interface SettingsWidgetState {
	readonly currentRepo: string | null;
	readonly scrollTop: number;
}

/**
 * Implements the Git Map View's Settings Widget.
 */
class SettingsWidget {
	private readonly view: GitGraphView;

	private currentRepo: string | null = null;
	private repo: Readonly<GG.GitRepoState> | null = null;
	private config: Readonly<GG.GitRepoConfig> | null = null;
	private loading: boolean = false;
	private scrollTop: number = 0;

	private readonly widgetElem: HTMLElement;
	private readonly contentsElem: HTMLElement;
	private readonly loadingElem: HTMLElement;

	/**
	 * Construct a new SettingsWidget instance.
	 * @param view The Git Map View that the SettingsWidget is for.
	 * @returns The SettingsWidget instance.
	 */
	constructor(view: GitGraphView) {
		this.view = view;

		this.widgetElem = document.createElement('div');
		this.widgetElem.id = 'settingsWidget';
		this.widgetElem.innerHTML = '<h2>' + t('Repository Settings') + '</h2><div id="settingsContent"></div><div id="settingsLoading"></div><div id="settingsClose"></div>';
		document.body.appendChild(this.widgetElem);

		observeElemScroll('settingsWidget', this.scrollTop, (scrollTop) => {
			this.scrollTop = scrollTop;
		}, () => {
			if (this.currentRepo !== null) {
				this.view.saveState();
			}
		});

		this.contentsElem = document.getElementById('settingsContent')!;
		this.loadingElem = document.getElementById('settingsLoading')!;

		const settingsClose = document.getElementById('settingsClose')!;
		settingsClose.innerHTML = SVG_ICONS.close;
		settingsClose.addEventListener('click', () => this.close());
	}

	/**
	 * Show the Settings Widget.
	 * @param currentRepo The repository that is currently loaded in the view.
	 * @param isInitialLoad Is this the initial load of the Setting Widget, or is it being shown when restoring a previous state.
	 * @param scrollTop The scrollTop the Settings Widget should initially be set to.
	 */
	public show(currentRepo: string, isInitialLoad: boolean = true, scrollTop: number = 0) {
		if (this.currentRepo !== null) return;
		this.currentRepo = currentRepo;
		this.scrollTop = scrollTop;
		alterClass(this.widgetElem, CLASS_TRANSITION, isInitialLoad);
		this.widgetElem.classList.add(CLASS_ACTIVE);
		this.view.saveState();
		this.refresh();
		if (isInitialLoad) {
			this.view.requestLoadConfig();
		}
	}

	/**
	 * Refresh the Settings Widget after an action affecting it's content has completed.
	 */
	public refresh() {
		if (this.currentRepo === null) return;
		this.repo = this.view.getRepoState(this.currentRepo);
		this.config = this.view.getRepoConfig();
		this.loading = this.view.isConfigLoading();
		this.render();
	}

	/**
	 * Close the Settings Widget, sliding it up out of view.
	 */
	public close() {
		if (this.currentRepo === null) return;
		this.currentRepo = null;
		this.repo = null;
		this.config = null;
		this.loading = false;
		this.widgetElem.classList.add(CLASS_TRANSITION);
		this.widgetElem.classList.remove(CLASS_ACTIVE);
		this.widgetElem.classList.remove(CLASS_LOADING);
		this.contentsElem.innerHTML = '';
		this.loadingElem.innerHTML = '';
		this.view.saveState();
	}


	/* State */

	/**
	 * Get the current state of the Settings Widget.
	 */
	public getState(): SettingsWidgetState {
		return {
			currentRepo: this.currentRepo,
			scrollTop: this.scrollTop
		};
	}

	/**
	 * Restore the Settings Widget to an existing state.
	 * @param state The previous Settings Widget state.
	 */
	public restoreState(state: SettingsWidgetState) {
		if (state.currentRepo === null) return;
		this.show(state.currentRepo, false, state.scrollTop);
	}

	/**
	 * Is the Settings Widget currently visible.
	 * @returns TRUE => The Settings Widget is visible, FALSE => The Settings Widget is not visible
	 */
	public isVisible() {
		return this.currentRepo !== null;
	}


	/* Render Methods */

	/**
	 * Render the Settings Widget.
	 */
	private render() {
		if (this.currentRepo !== null && this.repo !== null) {
			const escapedRepoName = escapeHtml(this.repo.name || getRepoName(this.currentRepo));

			const initialBranchesLocallyConfigured = this.repo.onRepoLoadShowCheckedOutBranch !== GG.BooleanOverride.Default || this.repo.onRepoLoadShowSpecificBranches !== null;
			const initialBranches: string[] = [];
			if (getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch)) {
				initialBranches.push(t('Checked Out'));
			}
			const branchOptions = this.view.getBranchOptions();
			getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches).forEach((branch) => {
				const option = branchOptions.find((option) => option.value === branch);
				if (option) {
					initialBranches.push(option.name);
				}
			});
			const initialBranchesStr = initialBranches.length > 0
				? escapeHtml(formatCommaSeparatedList(initialBranches))
				: t('Show All');

			let html = '<div class="settingsSection general"><h3>' + t('General') + '</h3>' +
				'<table>' +
				'<tr class="lineAbove"><td class="left">' + t('Name:') + '</td><td class="leftWithEllipsis" title="' + escapedRepoName + (this.repo.name === null ? t(' (Default Name from the File System)') : '') + '">' + escapedRepoName + '</td><td class="btns right"><div id="editRepoName" title="' + t('Edit Name') + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (this.repo.name !== null ? ' <div id="deleteRepoName" title="' + t('Delete Name') + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</td></tr>' +
				'<tr class="lineAbove lineBelow"><td class="left">' + t('Initial Branches:') + '</td><td class="leftWithEllipsis" title="' + initialBranchesStr + ' (' + (initialBranchesLocallyConfigured ? t('Local') : t('Global')) + ')">' + initialBranchesStr + '</td><td class="btns right"><div id="editInitialBranches" title="' + t('Edit Initial Branches') + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div>' + (initialBranchesLocallyConfigured ? ' <div id="clearInitialBranches" title="' + t('Clear Initial Branches') + ELLIPSIS + '">' + SVG_ICONS.close + '</div>' : '') + '</td></tr>' +
				'</table>' +
				'<label id="settingsShowStashes"><input type="checkbox" id="settingsShowStashesCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + t('Show Stashes') + '</label><br/>' +
				'<label id="settingsShowTags"><input type="checkbox" id="settingsShowTagsCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + t('Show Tags') + '</label><br/>' +
				'<label id="settingsIncludeCommitsMentionedByReflogs"><input type="checkbox" id="settingsIncludeCommitsMentionedByReflogsCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + t('Include commits only mentioned by reflogs') + '</label><span class="settingsWidgetInfo" title="' + t('Only applies when showing all branches.') + '">' + SVG_ICONS.info + '</span><br/>' +
				'<label id="settingsOnlyFollowFirstParent"><input type="checkbox" id="settingsOnlyFollowFirstParentCheckbox" tabindex="-1"><span class="customCheckbox"></span>' + t('Only follow the first parent of commits') + '</label><span class="settingsWidgetInfo" title="' + t('Instead of following all parents of commits, only follow the first parent when discovering the commits to load.') + '">' + SVG_ICONS.info + '</span>' +
				'</div>';

			let userNameSet = false, userEmailSet = false;
			if (this.config !== null) {
				html += '<div class="settingsSection centered"><h3>' + t('User Details') + '</h3>';
				const userName = this.config.user.name, userEmail = this.config.user.email;
				userNameSet = userName.local !== null || userName.global !== null;
				userEmailSet = userEmail.local !== null || userEmail.global !== null;
				if (userNameSet || userEmailSet) {
					const escapedUserName = escapeHtml(userName.local ?? userName.global ?? t('Not Set'));
					const escapedUserEmail = escapeHtml(userEmail.local ?? userEmail.global ?? t('Not Set'));
					html += '<table>' +
						'<tr><td class="left">' + t('User Name:') + '</td><td class="leftWithEllipsis" title="' + escapedUserName + (userNameSet ? ' (' + (userName.local !== null ? t('Local') : t('Global')) + ')' : '') + '">' + escapedUserName + '</td></tr>' +
						'<tr><td class="left">' + t('User Email:') + '</td><td class="leftWithEllipsis" title="' + escapedUserEmail + (userEmailSet ? ' (' + (userEmail.local !== null ? t('Local') : t('Global')) + ')' : '') + '">' + escapedUserEmail + '</td></tr>' +
						'</table>' +
						'<div class="settingsSectionButtons"><div id="editUserDetails" class="editBtn">' + SVG_ICONS.pencil + t('Edit') + '</div><div id="removeUserDetails" class="removeBtn">' + SVG_ICONS.close + t('Remove') + '</div></div>';
				} else {
					html += '<span>' + t('User Details (such as name and email) are used by Git to record the Author and Committer of commit objects.') + '</span>' +
						'<div class="settingsSectionButtons"><div id="editUserDetails" class="addBtn">' + SVG_ICONS.plus + t('Add User Details') + '</div></div>';
				}
				html += '</div>';

				html += '<div class="settingsSection"><h3>' + t('Remote Configuration') + '</h3><table><tr><th>' + t('Remote') + '</th><th>URL</th><th>' + t('Type') + '</th><th>' + t('Action') + '</th></tr>';
				if (this.config.remotes.length > 0) {
					const hideRemotes = this.repo.hideRemotes;
					this.config.remotes.forEach((remote, i) => {
						const hidden = hideRemotes.includes(remote.name);
						const fetchUrl = escapeHtml(remote.url || t('Not Set')), pushUrl = escapeHtml(remote.pushUrl || remote.url || t('Not Set'));
						html += '<tr class="lineAbove">' +
							'<td class="left" rowspan="2"><span class="hideRemoteBtn" data-index="' + i + '" title="' + (hidden ? t('Click to show branches of this remote.') : t('Click to hide branches of this remote.')) + '">' + (hidden ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen) + '</span>' + escapeHtml(remote.name) + '</td>' +
							'<td class="leftWithEllipsis" title="' + t('Fetch URL:') + ' ' + fetchUrl + '">' + fetchUrl + '</td><td>' + t('Fetch') + '</td>' +
							'<td class="btns remoteBtns" rowspan="2" data-index="' + i + '"><div class="fetchRemote" title="' + t('Fetch from Remote') + ELLIPSIS + '">' + SVG_ICONS.download + '</div> <div class="pruneRemote" title="' + t('Prune Remote') + ELLIPSIS + '">' + SVG_ICONS.branch + '</div><br><div class="editRemote" title="' + t('Edit Remote') + ELLIPSIS + '">' + SVG_ICONS.pencil + '</div> <div class="deleteRemote" title="' + t('Delete Remote') + ELLIPSIS + '">' + SVG_ICONS.close + '</div></td>' +
							'</tr><tr><td class="leftWithEllipsis" title="' + t('Push URL:') + ' ' + pushUrl + '">' + pushUrl + '</td><td>' + t('Push') + '</td></tr>';
					});
				} else {
					html += '<tr class="lineAbove"><td colspan="4">' + t('There are no remotes configured for this repository.') + '</td></tr>';
				}
				html += '</table><div class="settingsSectionButtons lineAbove"><div id="settingsAddRemote" class="addBtn">' + SVG_ICONS.plus + t('Add Remote') + '</div></div></div>';
			}

			html += '<div class="settingsSection centered"><h3>' + t('Issue Linking') + '</h3>';
			const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
			if (issueLinkingConfig !== null) {
				const escapedIssue = escapeHtml(issueLinkingConfig.issue), escapedUrl = escapeHtml(issueLinkingConfig.url);
				html += '<table><tr><td class="left">' + t('Issue Regex:') + '</td><td class="leftWithEllipsis" title="' + escapedIssue + '">' + escapedIssue + '</td></tr><tr><td class="left">' + t('Issue URL:') + '</td><td class="leftWithEllipsis" title="' + escapedUrl + '">' + escapedUrl + '</td></tr></table>' +
					'<div class="settingsSectionButtons"><div id="editIssueLinking" class="editBtn">' + SVG_ICONS.pencil + t('Edit') + '</div><div id="removeIssueLinking" class="removeBtn">' + SVG_ICONS.close + t('Remove') + '</div></div>';
			} else {
				html += '<span>' + t('Issue Linking converts issue numbers in commit &amp; tag messages into hyperlinks, that open the issue in your issue tracking system. If a branch\'s name contains an issue number, the issue can be viewed via the branch\'s context menu.') + '</span>' +
					'<div class="settingsSectionButtons"><div id="editIssueLinking" class="addBtn">' + SVG_ICONS.plus + t('Add Issue Linking') + '</div></div>';
			}
			html += '</div>';

			if (this.config !== null) {
				html += '<div class="settingsSection centered"><h3>' + t('Pull Request Creation') + '</h3>';
				const pullRequestConfig = this.repo.pullRequestConfig;
				if (pullRequestConfig !== null) {
					const provider = escapeHtml((pullRequestConfig.provider === GG.PullRequestProvider.Bitbucket
						? 'Bitbucket'
						: pullRequestConfig.provider === GG.PullRequestProvider.Custom
							? pullRequestConfig.custom.name
							: pullRequestConfig.provider === GG.PullRequestProvider.GitHub
								? 'GitHub'
								: 'GitLab'
					) + ' (' + pullRequestConfig.hostRootUrl + ')');
					const source = escapeHtml(pullRequestConfig.sourceOwner + '/' + pullRequestConfig.sourceRepo + ' (' + pullRequestConfig.sourceRemote + ')');
					const destination = escapeHtml(pullRequestConfig.destOwner + '/' + pullRequestConfig.destRepo + (pullRequestConfig.destRemote !== null ? ' (' + pullRequestConfig.destRemote + ')' : ''));
					const destinationBranch = escapeHtml(pullRequestConfig.destBranch);
					html += '<table><tr><td class="left">' + t('Provider:') + '</td><td class="leftWithEllipsis" title="' + provider + '">' + provider + '</td></tr>' +
						'<tr><td class="left">' + t('Source Repo:') + '</td><td class="leftWithEllipsis" title="' + source + '">' + source + '</td></tr>' +
						'<tr><td class="left">' + t('Destination Repo:') + '</td><td class="leftWithEllipsis" title="' + destination + '">' + destination + '</td></tr>' +
						'<tr><td class="left">' + t('Destination Branch:') + '</td><td class="leftWithEllipsis" title="' + destinationBranch + '">' + destinationBranch + '</td></tr></table>' +
						'<div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="editBtn">' + SVG_ICONS.pencil + t('Edit') + '</div><div id="removePullRequestIntegration" class="removeBtn">' + SVG_ICONS.close + t('Remove') + '</div></div>';
				} else {
					html += '<span>' + t('Pull Request Creation automates the opening and pre-filling of a Pull Request form, directly from a branch\'s context menu.') + '</span>' +
						'<div class="settingsSectionButtons"><div id="editPullRequestIntegration" class="addBtn">' + SVG_ICONS.plus + 'Configure "Pull Request Creation" Integration</div></div>';
				}
				html += '</div>';
			}

			html += '<div class="settingsSection"><h3>' + t('Git Map Configuration') + '</h3><div class="settingsSectionButtons">' +
				'<div id="openExtensionSettings">' + SVG_ICONS.gear + t('Open Git Map Extension Settings') + '</div><br/>' +
				'<div id="exportRepositoryConfig">' + SVG_ICONS.package + t('Export Repository Configuration') + '</div>' +
				'</div></div>';

			this.contentsElem.innerHTML = html;

			document.getElementById('editRepoName')!.addEventListener('click', () => {
				if (this.currentRepo === null || this.repo === null) return;
				dialog.showForm(t('Specify a Name for this Repository:'), [
					{ type: DialogInputType.Text, name: t('Name'), default: this.repo.name || '', placeholder: getRepoName(this.currentRepo) }
				], t('Save Name'), (values) => {
					if (this.currentRepo === null) return;
					this.view.saveRepoStateValue(this.currentRepo, 'name', <string>values[0] || null);
					this.view.renderRepoDropdownOptions();
					this.render();
				}, null);
			});

			if (this.repo.name !== null) {
				document.getElementById('deleteRepoName')!.addEventListener('click', () => {
					if (this.currentRepo === null || this.repo === null || this.repo.name === null) return;
					dialog.showConfirmation(t('Are you sure you want to delete the manually configured name <b><i>{0}</i></b> for this repository, and use the default name from the File System <b><i>{1}</i></b>?', escapeHtml(this.repo.name), escapeHtml(getRepoName(this.currentRepo))), t('Yes, delete'), () => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, 'name', null);
						this.view.renderRepoDropdownOptions();
						this.render();
					}, null);
				});
			}

			document.getElementById('editInitialBranches')!.addEventListener('click', () => {
				if (this.repo === null) return;
				const showCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.repo.onRepoLoadShowCheckedOutBranch);
				const showSpecificBranches = getOnRepoLoadShowSpecificBranches(this.repo.onRepoLoadShowSpecificBranches);
				dialog.showForm('<b>' + t('Configure Initial Branches') + '</b><p style="margin:6px 0;">' + t('Configure the branches that are initially shown when this repository is loaded in the Git Map View.') + '</p><p style="font-size:12px; margin:6px 0 0 0;">' + t('Note: When "Checked Out Branch" is Disabled, and no "Specific Branches" are selected, all branches will be shown.') + '</p>', [
					{ type: DialogInputType.Checkbox, name: t('Checked Out Branch'), value: showCheckedOutBranch },
					{ type: DialogInputType.Select, name: t('Specific Branches'), options: this.view.getBranchOptions(), defaults: showSpecificBranches, multiple: true }
				], t('Save Configuration'), (values) => {
					if (this.currentRepo === null) return;
					if (showCheckedOutBranch !== values[0] || !arraysStrictlyEqualIgnoringOrder(showSpecificBranches, <string[]>values[1])) {
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', values[0] ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', <string[]>values[1]);
						this.render();
					}
				}, null, t('Cancel'), null, false);
			});

			if (initialBranchesLocallyConfigured) {
				document.getElementById('clearInitialBranches')!.addEventListener('click', () => {
					dialog.showConfirmation(t('Are you sure you want to clear the branches that are initially shown when this repository is loaded in the Git Map View?'), t('Yes, clear'), () => {
						if (this.currentRepo === null) return;
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowCheckedOutBranch', GG.BooleanOverride.Default);
						this.view.saveRepoStateValue(this.currentRepo, 'onRepoLoadShowSpecificBranches', null);
						this.render();
					}, null);
				});
			}

			const showStashesElem = <HTMLInputElement>document.getElementById('settingsShowStashesCheckbox');
			showStashesElem.checked = getShowStashes(this.repo.showStashes);
			showStashesElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsShowStashesCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'showStashes', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const showTagsElem = <HTMLInputElement>document.getElementById('settingsShowTagsCheckbox');
			showTagsElem.checked = getShowTags(this.repo.showTags);
			showTagsElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsShowTagsCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'showTags', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const includeCommitsMentionedByReflogsElem = <HTMLInputElement>document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
			includeCommitsMentionedByReflogsElem.checked = getIncludeCommitsMentionedByReflogs(this.repo.includeCommitsMentionedByReflogs);
			includeCommitsMentionedByReflogsElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsIncludeCommitsMentionedByReflogsCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'includeCommitsMentionedByReflogs', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			const settingsOnlyFollowFirstParentElem = <HTMLInputElement>document.getElementById('settingsOnlyFollowFirstParentCheckbox');
			settingsOnlyFollowFirstParentElem.checked = getOnlyFollowFirstParent(this.repo.onlyFollowFirstParent);
			settingsOnlyFollowFirstParentElem.addEventListener('change', () => {
				if (this.currentRepo === null) return;
				const elem = <HTMLInputElement | null>document.getElementById('settingsOnlyFollowFirstParentCheckbox');
				if (elem === null) return;
				this.view.saveRepoStateValue(this.currentRepo, 'onlyFollowFirstParent', elem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
				this.view.refresh(true);
			});

			if (this.config !== null) {
				document.getElementById('editUserDetails')!.addEventListener('click', () => {
					if (this.config === null) return;
					const userName = this.config.user.name, userEmail = this.config.user.email;
					dialog.showForm(t('Set the user name and email used by Git to record the Author and Committer of commit objects:'), [
						{ type: DialogInputType.Text, name: t('User Name'), default: userName.local ?? userName.global ?? '', placeholder: null },
						{ type: DialogInputType.Text, name: t('User Email'), default: userEmail.local ?? userEmail.global ?? '', placeholder: null },
						{ type: DialogInputType.Checkbox, name: t('Use Globally'), value: userName.local === null && userEmail.local === null, info: t('Use the "User Name" and "User Email" globally for all Git repositories (it can be overridden per repository).') }
					], t('Set User Details'), (values) => {
						if (this.currentRepo === null) return;
						const useGlobally = <boolean>values[2];
						runAction({
							command: 'editUserDetails',
							repo: this.currentRepo,
							name: <string>values[0],
							email: <string>values[1],
							location: useGlobally ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local,
							deleteLocalName: useGlobally && userName.local !== null,
							deleteLocalEmail: useGlobally && userEmail.local !== null
						}, t('Setting User Details'));
					}, null);
				});

				if (userNameSet || userEmailSet) {
					document.getElementById('removeUserDetails')!.addEventListener('click', () => {
						if (this.config === null) return;
						const userName = this.config.user.name, userEmail = this.config.user.email;
						const isGlobal = userName.local === null && userEmail.local === null;
						dialog.showConfirmation((isGlobal ? t('Are you sure you want to remove the <b>globally configured</b> user name and email, which are used by Git to record the Author and Committer of commit objects?') : t('Are you sure you want to remove the <b>locally configured</b> user name and email, which are used by Git to record the Author and Committer of commit objects?')), t('Yes, remove'), () => {
							if (this.currentRepo === null) return;
							runAction({
								command: 'deleteUserDetails',
								repo: this.currentRepo,
								name: (isGlobal ? userName.global : userName.local) !== null,
								email: (isGlobal ? userEmail.global : userEmail.local) !== null,
								location: isGlobal ? GG.GitConfigLocation.Global : GG.GitConfigLocation.Local
							}, t('Removing User Details'));
						}, null);
					});
				}

				const pushUrlPlaceholder = t('Leave blank to use the Fetch URL');
				document.getElementById('settingsAddRemote')!.addEventListener('click', () => {
					dialog.showForm(t('Add a new remote to this repository:'), [
						{ type: DialogInputType.Text, name: t('Name'), default: '', placeholder: null },
						{ type: DialogInputType.Text, name: t('Fetch URL'), default: '', placeholder: null },
						{ type: DialogInputType.Text, name: t('Push URL'), default: '', placeholder: pushUrlPlaceholder },
						{ type: DialogInputType.Checkbox, name: t('Fetch Immediately'), value: true }
					], t('Add Remote'), (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'addRemote', repo: this.currentRepo, name: <string>values[0], url: <string>values[1], pushUrl: <string>values[2] !== '' ? <string>values[2] : null, fetch: <boolean>values[3] }, t('Adding Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('editRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm(t('Edit the remote <b><i>{0}</i></b>:', escapeHtml(remote.name)), [
						{ type: DialogInputType.Text, name: t('Name'), default: remote.name, placeholder: null },
						{ type: DialogInputType.Text, name: t('Fetch URL'), default: remote.url !== null ? remote.url : '', placeholder: null },
						{ type: DialogInputType.Text, name: t('Push URL'), default: remote.pushUrl !== null ? remote.pushUrl : '', placeholder: pushUrlPlaceholder }
					], t('Save Changes'), (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'editRemote', repo: this.currentRepo, nameOld: remote.name, nameNew: <string>values[0], urlOld: remote.url, urlNew: <string>values[1] !== '' ? <string>values[1] : null, pushUrlOld: remote.pushUrl, pushUrlNew: <string>values[2] !== '' ? <string>values[2] : null }, t('Saving Changes to Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('deleteRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showConfirmation(t('Are you sure you want to delete the remote <b><i>{0}</i></b>?', escapeHtml(remote.name)), t('Yes, delete'), () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'deleteRemote', repo: this.currentRepo, name: remote.name }, t('Deleting Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('fetchRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showForm(t('Are you sure you want to fetch from the remote <b><i>{0}</i></b>?', escapeHtml(remote.name)), [
						{ type: DialogInputType.Checkbox, name: t('Prune'), value: initialState.config.dialogDefaults.fetchRemote.prune, info: t('Before fetching, remove any remote-tracking references that no longer exist on the remote.') },
						{ type: DialogInputType.Checkbox, name: t('Prune Tags'), value: initialState.config.dialogDefaults.fetchRemote.pruneTags, info: t('Before fetching, remove any local tags that no longer exist on the remote. Requires Git >= 2.17.0, and "Prune" to be enabled.') }
					], t('Yes, fetch'), (values) => {
						if (this.currentRepo === null) return;
						runAction({ command: 'fetch', repo: this.currentRepo, name: remote.name, prune: <boolean>values[0], pruneTags: <boolean>values[1] }, t('Fetching from Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('pruneRemote', 'click', (e) => {
					const remote = this.getRemoteForBtnEvent(e);
					if (remote === null) return;
					dialog.showConfirmation(t('Are you sure you want to prune remote-tracking references that no longer exist on the remote <b><i>{0}</i></b>?', escapeHtml(remote.name)), t('Yes, prune'), () => {
						if (this.currentRepo === null) return;
						runAction({ command: 'pruneRemote', repo: this.currentRepo, name: remote.name }, t('Pruning Remote'));
					}, { type: TargetType.Repo });
				});

				addListenerToClass('hideRemoteBtn', 'click', (e) => {
					if (this.currentRepo === null || this.repo === null || this.config === null) return;
					const source = <HTMLElement>(<Element>e.target).closest('.hideRemoteBtn')!;
					const remote = this.config.remotes[parseInt(source.dataset.index!)].name;
					const hideRemote = !this.repo.hideRemotes.includes(remote);
					source.title = (hideRemote ? t('Click to show branches of this remote.') : t('Click to hide branches of this remote.'));
					source.innerHTML = hideRemote ? SVG_ICONS.eyeClosed : SVG_ICONS.eyeOpen;
					if (hideRemote) {
						this.repo.hideRemotes.push(remote);
					} else {
						this.repo.hideRemotes.splice(this.repo.hideRemotes.indexOf(remote), 1);
					}
					this.view.saveRepoStateValue(this.currentRepo, 'hideRemotes', this.repo.hideRemotes);
					this.view.refresh(true);
				});
			}

			document.getElementById('editIssueLinking')!.addEventListener('click', () => {
				if (this.repo === null) return;
				const issueLinkingConfig = this.repo.issueLinkingConfig || globalState.issueLinkingConfig;
				if (issueLinkingConfig !== null) {
					this.showIssueLinkingDialog(issueLinkingConfig.issue, issueLinkingConfig.url, this.repo.issueLinkingConfig === null && globalState.issueLinkingConfig !== null, true);
				} else {
					this.showIssueLinkingDialog(null, null, false, false);
				}
			});

			if (this.repo.issueLinkingConfig !== null || globalState.issueLinkingConfig !== null) {
				document.getElementById('removeIssueLinking')!.addEventListener('click', () => {
					if (this.repo === null) return;
					const locallyConfigured = this.repo.issueLinkingConfig !== null;
					dialog.showConfirmation(t('Are you sure you want to remove {0}?', (locallyConfigured ? (globalState.issueLinkingConfig !== null ? t('the <b>locally configured</b> ') : '') + t('Issue Linking from this repository') : t('the <b>globally configured</b> Issue Linking in Git Map'))), t('Yes, remove'), () => {
						this.setIssueLinkingConfig(null, !locallyConfigured);
					}, null);
				});
			}

			if (this.config !== null) {
				document.getElementById('editPullRequestIntegration')!.addEventListener('click', () => {
					if (this.repo === null || this.config === null) return;

					if (this.config.remotes.length === 0) {
						dialog.showError(t('Unable to configure the "Pull Request Creation" Integration'), t('The repository must have at least one remote to configure the "Pull Request Creation" Integration. There are no remotes in the current repository.'), null, null);
						return;
					}

					let config: GG.DeepWriteable<GG.PullRequestConfig>;
					if (this.repo.pullRequestConfig === null) {
						let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
						let sourceRemoteUrl = this.config.remotes[originIndex > -1 ? originIndex : 0].url;
						let provider: GG.PullRequestProvider;
						if (sourceRemoteUrl !== null) {
							if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*github/) !== null) {
								provider = GG.PullRequestProvider.GitHub;
							} else if (sourceRemoteUrl.match(/^(https?:\/\/|git@)[^/]*gitlab/) !== null) {
								provider = GG.PullRequestProvider.GitLab;
							} else {
								provider = GG.PullRequestProvider.Bitbucket;
							}
						} else {
							provider = GG.PullRequestProvider.Bitbucket;
						}
						config = {
							provider: provider, hostRootUrl: '',
							sourceRemote: '', sourceOwner: '', sourceRepo: '',
							destRemote: '', destOwner: '', destRepo: '', destProjectId: '', destBranch: '',
							custom: null
						};
					} else {
						config = Object.assign({}, this.repo.pullRequestConfig);
					}
					this.showCreatePullRequestIntegrationDialog1(config);
				});

				if (this.repo.pullRequestConfig !== null) {
					document.getElementById('removePullRequestIntegration')!.addEventListener('click', () => {
						dialog.showConfirmation(t('Are you sure you want to remove the configured "Pull Request Creation" Integration?'), t('Yes, remove'), () => {
							this.setPullRequestConfig(null);
						}, null);
					});
				}
			}

			document.getElementById('openExtensionSettings')!.addEventListener('click', () => {
				sendMessage({ command: 'openExtensionSettings' });
			});

			document.getElementById('exportRepositoryConfig')!.addEventListener('click', () => {
				dialog.showConfirmation(t('Exporting the Git Map Repository Configuration will generate a file that can be committed in this repository. It allows others working in this repository to use the same configuration.'), t('Yes, export'), () => {
					if (this.currentRepo === null) return;
					runAction({ command: 'exportRepoConfig', repo: this.currentRepo }, t('Exporting Repository Configuration'));
				}, null);
			});
		}

		alterClass(this.widgetElem, CLASS_LOADING, this.loading);
		this.loadingElem.innerHTML = this.loading ? '<span>' + SVG_ICONS.loading + t('Loading ...') + '</span>' : '';
		this.widgetElem.scrollTop = this.scrollTop;
		this.loadingElem.style.top = (this.scrollTop + (this.widgetElem.clientHeight / 2) - 12) + 'px';
	}


	/* Private Helper Methods */

	/**
	 * Save the issue linking configuration for this repository, and refresh the view so these changes are taken into affect.
	 * @param config The issue linking configuration to save.
	 * @param global Should this configuration be set globally for all repositories, or locally for this specific repository.
	 */
	private setIssueLinkingConfig(config: GG.IssueLinkingConfig | null, global: boolean) {
		if (this.currentRepo === null || this.repo === null) return;

		if (global) {
			if (this.repo.issueLinkingConfig !== null) {
				this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', null);
			}
			updateGlobalViewState('issueLinkingConfig', config);
		} else {
			this.view.saveRepoStateValue(this.currentRepo, 'issueLinkingConfig', config);
		}

		this.view.refresh(true);
		this.render();
	}

	/**
	 * Save the pull request configuration for this repository.
	 * @param config The pull request configuration to save.
	 */
	private setPullRequestConfig(config: GG.PullRequestConfig | null) {
		if (this.currentRepo === null) return;
		this.view.saveRepoStateValue(this.currentRepo, 'pullRequestConfig', config);
		this.render();
	}

	/**
	 * Show the dialog allowing the user to configure the issue linking for this repository.
	 * @param defaultIssueRegex The default regular expression used to match issue numbers.
	 * @param defaultIssueUrl The default URL for the issue number to be substituted into.
	 * @param defaultUseGlobally The default value for the checkbox determining whether the issue linking configuration should be used globally (for all repositories).
	 * @param isEdit Is the dialog editing an existing issue linking configuration.
	 */
	private showIssueLinkingDialog(defaultIssueRegex: string | null, defaultIssueUrl: string | null, defaultUseGlobally: boolean, isEdit: boolean) {
		let html = t('<b>{0} this Repository</b>', (isEdit ? t('Edit Issue Linking for') : t('Add Issue Linking to')));
		html += '<p style="font-size:12px; margin:6px 0;">' + t('The following example links {0} in commit messages to {1}:', '<b>#123</b>', '<b>https://github.com/owner/repo/issues/123</b>') + '</p>';
		html += '<table style="display:inline-table; width:360px; text-align:left; font-size:12px; margin-bottom:2px;"><tr><td>' + t('Issue Regex:') + '</td><td>#(\\d+)</td></tr><tr><td>' + t('Issue URL:') + '</td><td>https://github.com/owner/repo/issues/$1</td></tr></tbody></table>';

		if (!isEdit && defaultIssueRegex === null && defaultIssueUrl === null) {
			defaultIssueRegex = SettingsWidget.autoDetectIssueRegex(this.view.getCommits());
			if (defaultIssueRegex !== null) {
				defaultIssueUrl = this.config !== null ? SettingsWidget.autoDetectIssueUrl(defaultIssueRegex, this.config.remotes) : null;
				html += '<p style="font-size:12px"><i>' + (defaultIssueUrl !== null ? t('The prefilled Issue Regex and Issue URL were detected from the commit messages and remote in this repository. Review and/or correct them if necessary.') : t('The prefilled Issue Regex was detected in commit messages in this repository. Review and/or correct it if necessary.')) + '</i></p>';
			}
		}

		dialog.showForm(html, [
			{ type: DialogInputType.Text, name: t('Issue Regex'), default: defaultIssueRegex !== null ? defaultIssueRegex : '', placeholder: null, info: t('A regular expression that matches your issue numbers, with one or more capturing groups ( ) that will be substituted into the "Issue URL".') },
			{ type: DialogInputType.Text, name: t('Issue URL'), default: defaultIssueUrl !== null ? defaultIssueUrl : '', placeholder: null, info: t('The issue\'s URL in your issue tracking system, with placeholders ($1, $2, etc.) for the groups captured ( ) in the "Issue Regex".') },
			{ type: DialogInputType.Checkbox, name: t('Use Globally'), value: defaultUseGlobally, info: t('Use the "Issue Regex" and "Issue URL" for all repositories by default (it can be overridden per repository). Note: "Use Globally" is only suitable if identical Issue Linking applies to the majority of your repositories (e.g. when using JIRA or Pivotal Tracker).') }
		], t('Save'), (values) => {
			let issueRegex = (<string>values[0]).trim(), issueUrl = (<string>values[1]).trim(), useGlobally = <boolean>values[2];
			let regExpParseError = null;
			try {
				if (issueRegex.indexOf('(') === -1 || issueRegex.indexOf(')') === -1) {
					regExpParseError = t('The regular expression does not contain a capturing group ( ).');
				} else if (new RegExp(issueRegex, 'gu')) {
					regExpParseError = null;
				}
			} catch (e) {
				regExpParseError = e instanceof Error ? e.message : String(e);
			}
			if (regExpParseError !== null) {
				dialog.showError(t('Invalid Issue Regex'), regExpParseError, t('Go Back'), () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else if (!(/\$([1-9][0-9]*)/.test(issueUrl))) {
				dialog.showError(t('Invalid Issue URL'), t('The Issue URL does not contain any placeholders ($1, $2, etc.) for the issue number components captured in the Issue Regex.'), t('Go Back'), () => {
					this.showIssueLinkingDialog(issueRegex, issueUrl, useGlobally, isEdit);
				});
			} else {
				this.setIssueLinkingConfig({ issue: issueRegex, url: issueUrl }, useGlobally);
			}
		}, null, t('Cancel'), null, false);
	}

	/**
	 * Show the first dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog1(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		let originIndex = this.config.remotes.findIndex((remote) => remote.name === 'origin');
		let upstreamIndex = this.config.remotes.findIndex((remote) => remote.name === 'upstream');
		let sourceRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.sourceRemote);
		let destRemoteIndex = this.config.remotes.findIndex((remote) => remote.name === config.destRemote);

		if (config.sourceRemote === '' || sourceRemoteIndex === -1) {
			sourceRemoteIndex = originIndex > -1 ? originIndex : 0;
		}
		if (config.destRemote === '') {
			destRemoteIndex = upstreamIndex > -1 ? upstreamIndex : originIndex > -1 ? originIndex : 0;
		}

		let defaultProvider = config.provider.toString();
		let providerOptions = [
			{ name: t('Bitbucket'), value: (GG.PullRequestProvider.Bitbucket).toString() },
			{ name: t('GitHub'), value: (GG.PullRequestProvider.GitHub).toString() },
			{ name: t('GitLab'), value: (GG.PullRequestProvider.GitLab).toString() }
		];
		let providerTemplateLookup: { [name: string]: string } = {};
		initialState.config.customPullRequestProviders.forEach((provider) => {
			providerOptions.push({ name: provider.name, value: (providerOptions.length + 1).toString() });
			providerTemplateLookup[provider.name] = provider.templateUrl;
		});
		if (config.provider === GG.PullRequestProvider.Custom) {
			if (!providerOptions.some((provider) => provider.name === config.custom.name)) {
				// The existing custom Pull Request provider no longer exists, so add it.
				providerOptions.push({ name: config.custom.name, value: (providerOptions.length + 1).toString() });
				providerTemplateLookup[config.custom.name] = config.custom.templateUrl;
			}
			defaultProvider = providerOptions.find((provider) => provider.name === config.custom.name)!.value;
		}
		providerOptions.sort((a, b) => a.name.localeCompare(b.name));

		let sourceRemoteOptions = this.config.remotes.map((remote, index) => ({ name: remote.name, value: index.toString() }));
		let destRemoteOptions = sourceRemoteOptions.map((option) => option);
		destRemoteOptions.push({ name: t('Not a remote'), value: '-1' });

		dialog.showForm(t('Configure "Pull Request Creation" Integration (Step&nbsp;1/2)'), [
			{
				type: DialogInputType.Select, name: t('Provider'),
				options: providerOptions, default: defaultProvider,
				info: t('In addition to the built-in publicly hosted Pull Request providers, custom providers can be configured using the Extension Setting "git-graph.customPullRequestProviders" (e.g. for use with privately hosted Pull Request providers).')
			},
			{
				type: DialogInputType.Select, name: t('Source Remote'),
				options: sourceRemoteOptions, default: sourceRemoteIndex.toString(),
				info: t('The remote that corresponds to the source of the Pull Request.')
			},
			{
				type: DialogInputType.Select, name: t('Destination Remote'),
				options: destRemoteOptions, default: destRemoteIndex.toString(),
				info: t('The remote that corresponds to the destination / target of the Pull Request.')
			}
		], t('Next'), (values) => {
			if (this.config === null) return;

			let newProvider = <GG.PullRequestProvider>parseInt(<string>values[0]);
			if (newProvider > 3) newProvider = GG.PullRequestProvider.Custom;

			const newSourceRemoteIndex = parseInt(<string>values[1]);
			const newDestRemoteIndex = parseInt(<string>values[2]);
			const newSourceRemote = this.config.remotes[newSourceRemoteIndex].name;
			const newDestRemote = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].name : null;
			const newSourceUrl = this.config.remotes[newSourceRemoteIndex].url;
			const newDestUrl = newDestRemoteIndex > -1 ? this.config.remotes[newDestRemoteIndex].url : null;

			if (config.hostRootUrl === '' || config.provider !== newProvider) {
				const remoteUrlForHost = newSourceUrl !== null ? newSourceUrl : newDestUrl;
				if (remoteUrlForHost !== null) {
					const match = remoteUrlForHost.match(/^(https?:\/\/|git@)((?=[^/]+@)[^@]+@|(?![^/]+@))([^/:]+)/);
					config.hostRootUrl = match !== null ? 'https://' + match[3] : '';
				} else {
					config.hostRootUrl = '';
				}
			}

			if (newProvider === GG.PullRequestProvider.Custom) {
				const customProviderName = providerOptions.find((provider) => provider.value === <string>values[0])!.name;
				config.custom = { name: customProviderName, templateUrl: providerTemplateLookup[customProviderName] };
			} else {
				config.custom = null;
			}
			config.provider = newProvider;

			if (config.sourceRemote !== newSourceRemote) {
				config.sourceRemote = newSourceRemote;
				const match = newSourceUrl !== null ? newSourceUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
				config.sourceOwner = match !== null ? match[2] : '';
				config.sourceRepo = match !== null ? match[3] : '';
			}

			if (config.provider !== GG.PullRequestProvider.GitLab || config.destRemote !== newDestRemote) {
				config.destProjectId = '';
			}

			if (config.destRemote !== newDestRemote) {
				config.destRemote = newDestRemote;
				if (newDestRemote !== null) {
					const match = newDestUrl !== null ? newDestUrl.match(/^(https?:\/\/|git@)[^/:]+[/:]([^/]+)\/([^/]*?)(.git|)$/) : null;
					config.destOwner = match !== null ? match[2] : '';
					config.destRepo = match !== null ? match[3] : '';
					const branches = this.view.getBranches()
						.filter((branch) => branch.startsWith('remotes/' + newDestRemote + '/') && branch !== ('remotes/' + newDestRemote + '/HEAD'))
						.map((branch) => branch.substring(newDestRemote.length + 9));
					config.destBranch = branches.length > 0 ? branches.includes('master') ? 'master' : branches[0] : '';
				} else {
					config.destOwner = '';
					config.destRepo = '';
					config.destBranch = '';
				}
			}

			this.showCreatePullRequestIntegrationDialog2(config);
		}, { type: TargetType.Repo });
	}

	/**
	 * Show the second dialog for configuring the pull request integration.
	 * @param config The pull request configuration.
	 */
	private showCreatePullRequestIntegrationDialog2(config: GG.DeepWriteable<GG.PullRequestConfig>) {
		if (this.config === null) return;

		const destBranches = config.destRemote !== null
			? this.view.getBranches()
				.filter((branch) => branch.startsWith('remotes/' + config.destRemote + '/') && branch !== ('remotes/' + config.destRemote + '/HEAD'))
				.map((branch) => branch.substring(config.destRemote!.length + 9))
			: [];
		const destBranchInfo = t('The name of the branch that is the destination / target of the Pull Request.');

		const updateConfigWithFormValues = (values: DialogInputValue[]) => {
			const hostRootUri = <string>values[0];
			config.hostRootUrl = hostRootUri.endsWith('/') ? hostRootUri.substring(0, hostRootUri.length - 1) : hostRootUri;
			config.sourceOwner = <string>values[1];
			config.sourceRepo = <string>values[2];
			config.destOwner = <string>values[3];
			config.destRepo = <string>values[4];
			config.destProjectId = config.provider === GG.PullRequestProvider.GitLab ? <string>values[5] : '';
			const destBranch = <string>values[config.provider === GG.PullRequestProvider.GitLab ? 6 : 5];
			config.destBranch = config.destRemote === null || destBranches.length === 0
				? destBranch
				: destBranches[parseInt(destBranch)];
		};

		const inputs: DialogInput[] = [
			{ type: DialogInputType.Text, name: t('Host Root URL'), default: config.hostRootUrl, placeholder: null, info: t('The Pull Request provider\'s Host Root URL (e.g. https://github.com).') },
			{ type: DialogInputType.Text, name: t('Source Owner'), default: config.sourceOwner, placeholder: null, info: t('The owner of the repository that is the source of the Pull Request.') },
			{ type: DialogInputType.Text, name: t('Source Repo'), default: config.sourceRepo, placeholder: null, info: t('The name of the repository that is the source of the Pull Request.') },
			{ type: DialogInputType.Text, name: t('Destination Owner'), default: config.destOwner, placeholder: null, info: t('The owner of the repository that is the destination / target of the Pull Request.') },
			{ type: DialogInputType.Text, name: t('Destination Repo'), default: config.destRepo, placeholder: null, info: t('The name of the repository that is the destination / target of the Pull Request.') }
		];
		if (config.provider === GG.PullRequestProvider.GitLab) {
			inputs.push({ type: DialogInputType.Text, name: t('Destination Project ID'), default: config.destProjectId, placeholder: null, info: t('The GitLab Project ID of the destination / target of the Pull Request. Leave this field blank to use the default destination / target configured in GitLab.') });
		}
		inputs.push(config.destRemote === null || destBranches.length === 0
			? { type: DialogInputType.Text, name: t('Destination Branch'), default: config.destBranch, placeholder: null, info: destBranchInfo }
			: {
				type: DialogInputType.Select,
				name: t('Destination Branch'),
				options: destBranches.map((branch, index) => ({ name: branch, value: index.toString() })),
				default: destBranches.includes(config.destBranch) ? destBranches.indexOf(config.destBranch).toString() : '0',
				info: destBranchInfo
			}
		);

		dialog.showForm(t('Configure "Pull Request Creation" Integration (Step&nbsp;2/2)'), inputs, t('Save Configuration'), (values) => {
			updateConfigWithFormValues(values);
			this.setPullRequestConfig(config);
		}, { type: TargetType.Repo }, t('Back'), (values) => {
			updateConfigWithFormValues(values);
			this.showCreatePullRequestIntegrationDialog1(config);
		});
	}

	/**
	 * Get the remote details corresponding to a mouse event.
	 * @param e The mouse event.
	 * @returns The details of the remote.
	 */
	private getRemoteForBtnEvent(e: Event) {
		return this.config !== null
			? this.config.remotes[parseInt((<HTMLElement>(<Element>e.target).closest('.remoteBtns')!).dataset.index!)]
			: null;
	}

	/**
	 * Automatically detect common issue number formats in the specified commits, returning the most common.
	 * @param commits The commits to analyse.
	 * @returns The regular expression of the most likely issue number format.
	 */
	private static autoDetectIssueRegex(commits: ReadonlyArray<GG.GitCommit>) {
		const patterns = ['#(\\d+)', '^(\\d+)\\.(?=\\s|$)', '^(\\d+):(?=\\s|$)', '([A-Za-z]+-\\d+)'].map((pattern) => {
			const regexp = new RegExp(pattern);
			return {
				pattern: pattern,
				matches: commits.filter((commit) => regexp.test(commit.message)).length
			};
		}).sort((a, b) => b.matches - a.matches);

		if (patterns[0].matches > 0.1 * commits.length) {
			// If the most common pattern was matched in more than 10% of commits, return the pattern
			return patterns[0].pattern;
		}
		return null;
	}

	/**
	 * Automatically detect the Issue URL for "#123" style issue references, if the repository's remote is hosted on GitHub, GitLab or Bitbucket.
	 * @param issueRegex The Issue Regex being used.
	 * @param remotes The remotes of the repository.
	 * @returns The Issue URL, or NULL if it couldn't be detected.
	 */
	private static autoDetectIssueUrl(issueRegex: string, remotes: ReadonlyArray<{ readonly name: string, readonly url: string | null }>) {
		if (issueRegex !== '#(\\d+)' || remotes.length === 0) return null;

		const originIndex = remotes.findIndex((remote) => remote.name === 'origin');
		const remoteUrl = remotes[originIndex > -1 ? originIndex : 0].url;
		const match = remoteUrl !== null ? remoteUrl.match(/^(?:https?:\/\/(?:[^/@]+@)?|ssh:\/\/(?:[^/@]+@)?|git@)([^/:]+)(?::\d+)?[/:](.+?)(?:\.git)?\/?$/) : null;
		if (match === null) return null;

		const host = match[1], path = match[2];
		if (host.includes('github')) {
			return 'https://' + host + '/' + path + '/issues/$1';
		} else if (host.includes('gitlab')) {
			return 'https://' + host + '/' + path + '/-/issues/$1';
		} else if (host.includes('bitbucket')) {
			return 'https://' + host + '/' + path + '/issues/$1';
		}
		return null;
	}
}
