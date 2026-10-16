class GitGraphView {
	private gitRepos: GG.GitRepoSet;
	private gitBranches: ReadonlyArray<string> = [];
	private gitBranchHead: string | null = null;
	private gitConfig: GG.GitRepoConfig | null = null;
	private gitRemotes: ReadonlyArray<string> = [];
	private gitStashes: ReadonlyArray<GG.GitStash> = [];
	private gitUpstreams: GG.GitBranchUpstreams = {};
	private gitTags: ReadonlyArray<string> = [];
	private commits: GG.GitCommit[] = [];
	private loadedCommits: GG.GitCommit[] = []; // All of the loaded commits (when only the matches of the Find Widget are shown, this.commits only contains them)
	private commitFilter: ReadonlySet<string> | null = null;
	private fileHistory: string | null = null; // The path of the file whose history is shown (NULL => all commits are shown)
	private fileHistoryData: GG.GitFileHistory | null = null;
	private cdvShowWholeCommit: boolean = false;
	private commitStats: { [hash: string]: GG.GitCommitStats | null } = {}; // The files & lines changed by the loaded commits (shown in the Changes column)
	private readonly commitStatsRequested: Set<string> = new Set();
	private cdvFileDiff: { key: string, diff: string | null, error: GG.ErrorInfo } | null = null;
	private commitHead: string | null = null;
	private commitLookup: { [hash: string]: number } = {};
	private onlyFollowFirstParent: boolean = false;
	private avatars: AvatarImageCollection = {};
	private currentBranches: string[] | null = null;
	private currentAuthors: string[] | null = null;
	private knownAuthors: string[] = [];

	private currentRepo!: string;
	private currentRepoLoading: boolean = true;
	private currentRepoRefreshState: {
		inProgress: boolean;
		hard: boolean;
		loadRepoInfoRefreshId: number;
		loadCommitsRefreshId: number;
		repoInfoChanges: boolean;
		configChanges: boolean;
		requestingRepoInfo: boolean;
		requestingConfig: boolean;
	};
	private loadViewTo: GG.LoadGitGraphViewTo = null;

	private readonly graph: Graph;
	private readonly config: Config;

	private moreCommitsAvailable: boolean = false;
	private scrollToHeadPending: boolean = false;
	private cdvComparePending: boolean = false;
	private scrollToStashPending: { stash: GG.GitStash, attempts: number } | null = null;
	private stashStats: { [hash: string]: GG.GitStashStats } = {};
	private expandedCommit: ExpandedCommit | null = null;
	private maxCommits: number;
	private scrollTop = 0;
	private renderedGitBranchHead: string | null = null;

	private lastScrollToStash: {
		time: number,
		hash: string | null
	} = { time: 0, hash: null };

	private readonly findWidget: FindWidget;
	private readonly settingsWidget: SettingsWidget;
	private readonly minimap: Minimap;
	private readonly scrollMarkers: ScrollMarkers;
	private readonly repoDropdown: Dropdown;
	private readonly branchDropdown: Dropdown;
	private readonly authorDropdown: Dropdown;

	private readonly viewElem: HTMLElement;
	private readonly controlsElem: HTMLElement;
	private readonly tableElem: HTMLElement;
	private readonly footerElem: HTMLElement;
	private readonly showRemoteBranchesElem: HTMLInputElement;
	private readonly refreshBtnElem: HTMLElement;
	private readonly scrollShadowElem: HTMLElement;

	constructor(viewElem: HTMLElement, prevState: WebViewState | null) {
		this.gitRepos = initialState.repos;
		this.config = initialState.config;
		this.maxCommits = this.config.initialLoadCommits;
		this.viewElem = viewElem;
		this.currentRepoRefreshState = {
			inProgress: false,
			hard: true,
			loadRepoInfoRefreshId: initialState.loadRepoInfoRefreshId,
			loadCommitsRefreshId: initialState.loadCommitsRefreshId,
			repoInfoChanges: false,
			configChanges: false,
			requestingRepoInfo: false,
			requestingConfig: false
		};

		this.controlsElem = document.getElementById('controls')!;
		this.tableElem = document.getElementById('commitTable')!;
		this.footerElem = document.getElementById('footer')!;
		this.scrollShadowElem = <HTMLInputElement>document.getElementById('scrollShadow')!;

		viewElem.focus();

		this.graph = new Graph('commitGraph', viewElem, this.config.graph, this.config.mute);
		this.minimap = new Minimap(document.getElementById('minimap')!, (index) => {
			if (index < this.commits.length) this.scrollToCommit(this.commits[index].hash, true, true);
		});
		this.scrollMarkers = new ScrollMarkers(viewElem);

		this.repoDropdown = new Dropdown('repoDropdown', true, false, 'Repos', (values) => {
			this.loadRepo(values[0]);
		});

		this.branchDropdown = new Dropdown('branchDropdown', false, true, 'Branches', (values) => {
			this.currentBranches = values;
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		});

		this.authorDropdown = new Dropdown('authorDropdown', false, true, 'Authors', (values) => {
			this.currentAuthors = values;
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		});

		this.showRemoteBranchesElem = <HTMLInputElement>document.getElementById('showRemoteBranchesCheckbox')!;
		this.showRemoteBranchesElem.addEventListener('change', () => {
			this.saveRepoStateValue(this.currentRepo, 'showRemoteBranchesV2', this.showRemoteBranchesElem.checked ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
			this.refresh(true);
		});

		this.refreshBtnElem = document.getElementById('refreshBtn')!;
		this.refreshBtnElem.addEventListener('click', () => {
			if (!this.refreshBtnElem.classList.contains(CLASS_REFRESHING)) {
				this.refresh(true, true);
			}
		});
		this.renderRefreshButton();

		this.findWidget = new FindWidget(this);
		this.settingsWidget = new SettingsWidget(this);
		this.observeOverviews();

		alterClass(document.body, CLASS_BRANCH_LABELS_ALIGNED_TO_GRAPH, this.config.referenceLabels.branchLabelsAlignedToGraph);
		alterClass(document.body, 'compactRows', this.config.graph.density === GG.GraphDensity.Compact);
		alterClass(document.body, CLASS_TAG_LABELS_RIGHT_ALIGNED, this.config.referenceLabels.tagLabelsOnRight);

		this.observeWindowSizeChanges();
		this.observeWebviewStyleChanges();
		this.observeViewScroll();
		this.observeKeyboardEvents();
		this.observeMouseNavigationButtons();
		this.observeUrls();
		this.observeTableEvents();

		if (prevState && !prevState.currentRepoLoading && typeof this.gitRepos[prevState.currentRepo] !== 'undefined') {
			this.currentRepo = prevState.currentRepo;
			this.currentBranches = prevState.currentBranches;
			this.currentAuthors = prevState.currentAuthors || null;
			this.knownAuthors = prevState.knownAuthors || [];
			this.maxCommits = prevState.maxCommits;
			this.expandedCommit = prevState.expandedCommit;
			this.avatars = prevState.avatars;
			this.gitConfig = prevState.gitConfig;
			this.loadRepoInfo(prevState.gitBranches, prevState.gitBranchHead, prevState.gitRemotes, prevState.gitStashes, prevState.gitUpstreams || {}, true);
			this.fileHistory = prevState.fileHistory || null;
			this.fileHistoryData = prevState.fileHistoryData || null;
			this.renderFileHistoryBar();
			this.loadCommits(prevState.commits, prevState.commitHead, prevState.gitTags, prevState.moreCommitsAvailable, prevState.onlyFollowFirstParent, this.fileHistoryData);
			this.findWidget.restoreState(prevState.findWidget);
			this.settingsWidget.restoreState(prevState.settingsWidget);
			this.showRemoteBranchesElem.checked = getShowRemoteBranches(this.gitRepos[prevState.currentRepo].showRemoteBranchesV2);
		}

		let loadViewTo = initialState.loadViewTo;
		if (loadViewTo === null && prevState && prevState.currentRepoLoading && typeof prevState.currentRepo !== 'undefined') {
			loadViewTo = { repo: prevState.currentRepo };
		}

		if (!this.loadRepos(this.gitRepos, initialState.lastActiveRepo, loadViewTo)) {
			if (prevState) {
				this.scrollTop = prevState.scrollTop;
				this.viewElem.scroll(0, this.scrollTop);
			}
			this.requestLoadRepoInfoAndCommits(false, false);
		}

		sendMessage({ command: 'loadFileIconTheme' });

		const fetchBtn = document.getElementById('fetchBtn')!, scrollToHeadBtn = document.getElementById('scrollToHeadBtn')!, settingsBtn = document.getElementById('settingsBtn')!, terminalBtn = document.getElementById('terminalBtn')!;
		fetchBtn.title = this.config.fetchAndPrune ? t('Fetch & Prune from Remote(s)') : t('Fetch from Remote(s)');
		fetchBtn.innerHTML = SVG_ICONS.fetch + '<span>' + t('Fetch') + '</span>';
		fetchBtn.addEventListener('click', () => this.fetchFromRemotesAction());
		document.getElementById('pullBtn')!.addEventListener('click', () => this.pullUpstreamAction());
		document.getElementById('pushBtn')!.addEventListener('click', () => {
			if (this.gitBranchHead !== null && this.gitRemotes.length > 0) this.pushBranchAction(this.gitBranchHead, null);
		});
		document.getElementById('stashBtn')!.addEventListener('click', (e) => this.showStashList(<HTMLElement>e.currentTarget, e));
		document.addEventListener('click', () => this.closeStashList());
		scrollToHeadBtn.innerHTML = SVG_ICONS.head + '<span>HEAD</span>';
		scrollToHeadBtn.addEventListener('click', () => this.scrollToHead());
		settingsBtn.innerHTML = SVG_ICONS.gear;
		settingsBtn.addEventListener('click', () => this.settingsWidget.show(this.currentRepo));
		terminalBtn.innerHTML = SVG_ICONS.terminal;
		terminalBtn.addEventListener('click', () => {
			runAction({
				command: 'openTerminal',
				repo: this.currentRepo,
				name: this.gitRepos[this.currentRepo].name || getRepoName(this.currentRepo)
			}, t('Opening Terminal'));
		});
	}


	/* Loading Data */

	public loadRepos(repos: GG.GitRepoSet, lastActiveRepo: string | null, loadViewTo: GG.LoadGitGraphViewTo) {
		this.gitRepos = repos;
		this.saveState();

		let newRepo: string;
		if (loadViewTo !== null && this.currentRepo !== loadViewTo.repo && typeof repos[loadViewTo.repo] !== 'undefined') {
			newRepo = loadViewTo.repo;
		} else if (typeof repos[this.currentRepo] === 'undefined') {
			newRepo = lastActiveRepo !== null && typeof repos[lastActiveRepo] !== 'undefined'
				? lastActiveRepo
				: getSortedRepositoryPaths(repos, this.config.repoDropdownOrder)[0];
		} else {
			newRepo = this.currentRepo;
		}

		alterClass(this.controlsElem, 'singleRepo', Object.keys(repos).length === 1);
		this.renderRepoDropdownOptions(newRepo);

		if (loadViewTo !== null) {
			if (loadViewTo.repo === newRepo) {
				this.loadViewTo = loadViewTo;
			} else {
				this.loadViewTo = null;
				showErrorMessage(t('Unable to load the Git Map View for the repository "{0}". It is not currently included in Git Map.', loadViewTo.repo));
			}
		} else {
			this.loadViewTo = null;
		}

		const fileHistory = loadViewTo !== null && loadViewTo.repo === newRepo && typeof loadViewTo.fileHistory === 'string' ? loadViewTo.fileHistory : null;
		if (this.currentRepo !== newRepo) {
			this.loadRepo(newRepo, fileHistory);
			return true;
		} else if (fileHistory !== null) {
			this.setFileHistory(fileHistory);
			return true;
		} else if (loadViewTo !== null && loadViewTo.repo === newRepo && loadViewTo.fileHistory === null && this.fileHistory !== null) {
			this.setFileHistory(null);
			return true;
		} else {
			this.finaliseRepoLoad(false);
			return false;
		}
	}

	private loadRepo(repo: string, fileHistory: string | null = null) {
		this.fileHistory = fileHistory;
		this.fileHistoryData = null;
		this.renderFileHistoryBar();
		this.currentRepo = repo;
		this.currentRepoLoading = true;
		this.scrollToHeadPending = false;
		this.showRemoteBranchesElem.checked = getShowRemoteBranches(this.gitRepos[this.currentRepo].showRemoteBranchesV2);
		this.maxCommits = this.config.initialLoadCommits;
		this.gitConfig = null;
		this.gitRemotes = [];
		this.gitStashes = [];
		this.gitUpstreams = {};
		this.stashStats = {};
		this.commitStats = {};
		this.commitStatsRequested.clear();
		this.scrollToStashPending = null;
		this.closeStashList();
		this.gitTags = [];
		this.currentBranches = null;
		this.currentAuthors = null;
		this.knownAuthors = [];
		this.renderAuthorDropdown();
		this.renderFetchButton();
		this.renderSyncButtons();
		this.renderStashButton();
		this.closeCommitDetails(false);
		this.settingsWidget.close();
		this.saveState();
		this.refresh(true);
	}

	private loadRepoInfo(branchOptions: ReadonlyArray<string>, branchHead: string | null, remotes: ReadonlyArray<string>, stashes: ReadonlyArray<GG.GitStash>, upstreams: GG.GitBranchUpstreams, isRepo: boolean) {
		// Changes to this.gitStashes are reflected as changes to the commits when loadCommits is run
		this.gitStashes = stashes;
		this.gitUpstreams = upstreams;
		this.renderStashButton();
		if (stashes.length === 0) this.closeStashList(); else this.renderStashList();
		if (isRepo) this.renderSyncButtons(branchHead);

		if (!isRepo || (!this.currentRepoRefreshState.hard && arraysStrictlyEqual(this.gitBranches, branchOptions) && this.gitBranchHead === branchHead && arraysStrictlyEqual(this.gitRemotes, remotes))) {
			this.saveState();
			this.finaliseLoadRepoInfo(false, isRepo);
			return;
		}

		// Changes to these properties must be indicated as a repository info change
		this.gitBranches = branchOptions;
		this.gitBranchHead = branchHead;
		this.gitRemotes = remotes;

		// Update the state of the fetch button
		this.renderFetchButton();

		// Configure current branches
		if (this.currentBranches !== null && !(this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES)) {
			// Filter any branches that are currently selected, but no longer exist
			const globPatterns = this.config.customBranchGlobPatterns.map((pattern) => pattern.glob);
			this.currentBranches = this.currentBranches.filter((branch) =>
				this.gitBranches.includes(branch) || globPatterns.includes(branch)
			);
		}
		if (this.currentBranches === null || this.currentBranches.length === 0) {
			// No branches are currently selected
			const onRepoLoadShowCheckedOutBranch = getOnRepoLoadShowCheckedOutBranch(this.gitRepos[this.currentRepo].onRepoLoadShowCheckedOutBranch);
			const onRepoLoadShowSpecificBranches = getOnRepoLoadShowSpecificBranches(this.gitRepos[this.currentRepo].onRepoLoadShowSpecificBranches);
			this.currentBranches = [];
			if (onRepoLoadShowSpecificBranches.length > 0) {
				// Show specific branches if they exist in the repository
				const globPatterns = this.config.customBranchGlobPatterns.map((pattern) => pattern.glob);
				this.currentBranches.push(...onRepoLoadShowSpecificBranches.filter((branch) =>
					this.gitBranches.includes(branch) || globPatterns.includes(branch)
				));
			}
			if (onRepoLoadShowCheckedOutBranch && this.gitBranchHead !== null && !this.currentBranches.includes(this.gitBranchHead)) {
				// Show the checked-out branch, and it hasn't already been added as a specific branch
				this.currentBranches.push(this.gitBranchHead);
			}
			if (this.currentBranches.length === 0) {
				this.currentBranches.push(SHOW_ALL_BRANCHES);
			}
		}

		this.saveState();

		// Set up branch dropdown options
		this.branchDropdown.setOptions(this.getBranchOptions(true), this.currentBranches);

		// Remove hidden remotes that no longer exist
		let hiddenRemotes = this.gitRepos[this.currentRepo].hideRemotes;
		let hideRemotes = hiddenRemotes.filter((hiddenRemote) => remotes.includes(hiddenRemote));
		if (hiddenRemotes.length !== hideRemotes.length) {
			this.saveRepoStateValue(this.currentRepo, 'hideRemotes', hideRemotes);
		}

		this.finaliseLoadRepoInfo(true, isRepo);
	}

	private finaliseLoadRepoInfo(repoInfoChanges: boolean, isRepo: boolean) {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			if (isRepo) {
				refreshState.repoInfoChanges = refreshState.repoInfoChanges || repoInfoChanges;
				refreshState.requestingRepoInfo = false;
				this.requestLoadCommits();
			} else {
				dialog.closeActionRunning();
				refreshState.inProgress = false;
				this.loadViewTo = null;
				this.renderRefreshButton();
				sendMessage({ command: 'loadRepos', check: true });
			}
		}
	}

	private loadCommits(commits: GG.GitCommit[], commitHead: string | null, tags: ReadonlyArray<string>, moreAvailable: boolean, onlyFollowFirstParent: boolean, fileHistory: GG.GitFileHistory | null = null) {
		this.fileHistoryData = this.fileHistory !== null && fileHistory !== null && fileHistory.filePath === this.fileHistory ? fileHistory : null;
		// This list of tags is just used to provide additional information in the dialogs. Tag information included in commits is used for all other purposes (e.g. rendering, context menus)
		const tagsChanged = !arraysStrictlyEqual(this.gitTags, tags);
		this.gitTags = tags;

		if (!this.currentRepoLoading && !this.currentRepoRefreshState.hard && this.moreCommitsAvailable === moreAvailable && this.onlyFollowFirstParent === onlyFollowFirstParent && this.commitHead === commitHead && commits.length > 0 && arraysEqual(this.loadedCommits, commits, (a, b) =>
			a.hash === b.hash &&
			arraysStrictlyEqual(a.heads, b.heads) &&
			arraysEqual(a.tags, b.tags, (a, b) => a.name === b.name && a.annotated === b.annotated) &&
			arraysEqual(a.remotes, b.remotes, (a, b) => a.name === b.name && a.remote === b.remote) &&
			arraysStrictlyEqual(a.parents, b.parents) &&
			((a.stash === null && b.stash === null) || (a.stash !== null && b.stash !== null && a.stash.selector === b.stash.selector))
		) && this.renderedGitBranchHead === this.gitBranchHead) {

			if (this.loadedCommits[0].hash === UNCOMMITTED) {
				this.loadedCommits[0] = commits[0]; // Also updates this.commits, unless only the matches of the Find Widget are shown (which don't include the uncommitted changes)
				this.saveState();
				if (this.commitFilter === null) this.renderUncommittedChanges();
				if (this.commitFilter === null && this.expandedCommit !== null && this.expandedCommit.commitElem !== null) {
					if (this.expandedCommit.compareWithHash === null) {
						// Commit Details View is open
						if (this.expandedCommit.commitHash === UNCOMMITTED) {
							this.requestCommitDetails(this.expandedCommit.commitHash, true);
						}
					} else {
						// Commit Comparison is open
						if (this.expandedCommit.compareWithElem !== null && (this.expandedCommit.commitHash === UNCOMMITTED || this.expandedCommit.compareWithHash === UNCOMMITTED)) {
							this.requestCommitComparison(this.expandedCommit.commitHash, this.expandedCommit.compareWithHash, true);
						}
					}
				}
			} else if (tagsChanged) {
				this.saveState();
			}
			this.finaliseLoadCommits();
			return;
		}

		const currentRepoLoading = this.currentRepoLoading;
		this.currentRepoLoading = false;
		this.moreCommitsAvailable = moreAvailable;
		this.onlyFollowFirstParent = onlyFollowFirstParent;
		this.loadedCommits = commits;
		this.commitHead = commitHead;
		if (this.findWidget.isFiltering()) this.commitFilter = this.findWidget.getMatchingHashes(commits);
		const avatarsNeeded = this.showCommits();
		this.renderFileHistoryBar();

		if (currentRepoLoading && this.config.onRepoLoad.scrollToHead && this.commitHead !== null) {
			this.scrollToCommit(this.commitHead, true);
		}

		this.finaliseLoadCommits();
		this.requestAvatars(avatarsNeeded);
	}

	/**
	 * Show the loaded commits (or only those that match the Find Widget, when only its matches are shown) in the view.
	 * @returns The avatars that need to be requested for the commits.
	 */
	private showCommits() {
		this.commits = this.commitFilter !== null ? filterCommits(this.loadedCommits, this.commitFilter) : this.loadedCommits;
		this.commitLookup = {};

		let i: number, expandedCommitVisible = false, expandedCompareWithCommitVisible = false, avatarsNeeded: { [email: string]: string[] } = {}, commit;
		for (i = 0; i < this.commits.length; i++) {
			commit = this.commits[i];
			this.commitLookup[commit.hash] = i;
			if (this.expandedCommit !== null) {
				if (this.expandedCommit.commitHash === commit.hash) {
					expandedCommitVisible = true;
				} else if (this.expandedCommit.compareWithHash === commit.hash) {
					expandedCompareWithCommitVisible = true;
				}
			}
			if (this.config.fetchAvatars && typeof this.avatars[commit.email] !== 'string' && commit.email !== '') {
				if (typeof avatarsNeeded[commit.email] === 'undefined') {
					avatarsNeeded[commit.email] = [commit.hash];
				} else {
					avatarsNeeded[commit.email].push(commit.hash);
				}
			}
		}

		if (this.expandedCommit !== null && (!expandedCommitVisible || (this.expandedCommit.compareWithHash !== null && !expandedCompareWithCommitVisible))) {
			this.closeCommitDetails(false);
		}

		this.saveState();

		this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent);
		this.render();
		this.updateKnownAuthors();
		this.requestCommitStats(true);
		return avatarsNeeded;
	}

	/**
	 * Set the commits that are shown: only the commits that match the Find Widget, or all of the loaded commits.
	 * @param filter The hashes of the commits to show, or NULL to show all of the loaded commits.
	 */
	public setCommitFilter(filter: ReadonlySet<string> | null) {
		const current = this.commitFilter;
		if (filter === null ? current === null : current !== null && filter.size === current.size && Array.from(filter).every((hash) => current.has(hash))) return;
		this.commitFilter = filter;
		this.showCommits();
	}

	/**
	 * Get all of the loaded commits (including those not shown when only the matches of the Find Widget are shown).
	 * @returns The commits.
	 */
	public getLoadedCommits(): ReadonlyArray<GG.GitCommit> {
		return this.loadedCommits;
	}

	/**
	 * Get the date of the oldest loaded commit, used to limit searches to the loaded commits.
	 * @returns The unix timestamp of the date (less a day to allow for the difference between author & committer dates), or 0 if all commits are loaded.
	 */
	public getOldestLoadedCommitDate() {
		if (!this.moreCommitsAvailable) return 0;
		let oldest = Infinity;
		this.loadedCommits.forEach((commit) => {
			if (commit.hash !== UNCOMMITTED && commit.date < oldest) oldest = commit.date;
		});
		return oldest !== Infinity ? Math.max(oldest - 86400, 1) : 0;
	}

	/**
	 * Get the path of the repository currently shown in the view.
	 * @returns The path of the repository.
	 */
	public getCurrentRepo() {
		return this.currentRepo;
	}

	private finaliseLoadCommits() {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			dialog.closeActionRunning();

			if (dialog.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					dialog.close();
				} else {
					dialog.refresh(this.getCommits());
				}
			}

			if (contextMenu.isTargetDynamicSource()) {
				if (refreshState.repoInfoChanges) {
					contextMenu.close();
				} else {
					contextMenu.refresh(this.getCommits());
				}
			}

			refreshState.inProgress = false;
			this.renderRefreshButton();
		}

		this.finaliseRepoLoad(true);

		if (this.scrollToHeadPending) {
			this.scrollToHead();
		}
		if (this.scrollToStashPending !== null) {
			this.goToStash(this.scrollToStashPending.stash);
		}
	}

	private finaliseRepoLoad(didLoadRepoData: boolean) {
		if (this.loadViewTo !== null && this.currentRepo === this.loadViewTo.repo) {
			if (this.loadViewTo.commitDetails && (this.expandedCommit === null || this.expandedCommit.commitHash !== this.loadViewTo.commitDetails.commitHash || this.expandedCommit.compareWithHash !== this.loadViewTo.commitDetails.compareWithHash)) {
				const commitIndex = this.getCommitId(this.loadViewTo.commitDetails.commitHash);
				const compareWithIndex = this.loadViewTo.commitDetails.compareWithHash !== null ? this.getCommitId(this.loadViewTo.commitDetails.compareWithHash) : null;
				const commitElems = getCommitElems();
				const commitElem = findCommitElemWithId(commitElems, commitIndex);
				const compareWithElem = findCommitElemWithId(commitElems, compareWithIndex);

				if (commitElem !== null && (this.loadViewTo.commitDetails.compareWithHash === null || compareWithElem !== null)) {
					if (compareWithElem !== null) {
						this.loadCommitComparison(commitElem, compareWithElem);
					} else {
						this.loadCommitDetails(commitElem);
					}
				} else {
					showErrorMessage(t('Unable to resume Code Review, it could not be found in the latest {0} commits that were loaded in this repository.', this.maxCommits));
				}
			} else if (this.loadViewTo.runCommandOnLoad) {
				switch (this.loadViewTo.runCommandOnLoad) {
					case 'fetch':
						this.fetchFromRemotesAction();
						break;
				}
			}
		}
		this.loadViewTo = null;

		if (this.gitConfig === null || (didLoadRepoData && this.currentRepoRefreshState.configChanges)) {
			this.requestLoadConfig();
		}
	}

	private clearCommits() {
		closeDialogAndContextMenu();
		this.moreCommitsAvailable = false;
		this.commits = [];
		this.loadedCommits = this.commits;
		this.commitHead = null;
		this.commitLookup = {};
		this.renderedGitBranchHead = null;
		this.closeCommitDetails(false);
		this.saveState();
		this.graph.loadCommits(this.commits, this.commitHead, this.commitLookup, this.onlyFollowFirstParent);
		this.tableElem.innerHTML = '';
		this.footerElem.innerHTML = '';
		this.renderGraph();
		this.findWidget.refresh();
	}

	public processLoadRepoInfoResponse(msg: GG.ResponseLoadRepoInfo) {
		if (msg.error === null) {
			const refreshState = this.currentRepoRefreshState;
			if (refreshState.inProgress && refreshState.loadRepoInfoRefreshId === msg.refreshId) {
				this.loadRepoInfo(msg.branches, msg.head, msg.remotes, msg.stashes, msg.upstreams, msg.isRepo);
			}
		} else {
			this.displayLoadDataError(t('Unable to load Repository Info'), msg.error);
		}
	}

	public processSearchCommitsResponse(msg: GG.ResponseSearchCommits) {
		this.findWidget.processSearchCommitsResponse(msg);
	}

	public processLoadCommitsResponse(msg: GG.ResponseLoadCommits) {
		if (msg.error === null) {
			const refreshState = this.currentRepoRefreshState;
			if (refreshState.inProgress && refreshState.loadCommitsRefreshId === msg.refreshId) {
				this.loadCommits(msg.commits, msg.head, msg.tags, msg.moreCommitsAvailable, msg.onlyFollowFirstParent, msg.fileHistory);
			}
		} else {
			const error = this.gitBranches.length === 0 && msg.error.indexOf('bad revision \'HEAD\'') > -1
				? t('There are no commits in this repository.')
				: msg.error;
			this.displayLoadDataError(t('Unable to load Commits'), error);
		}
	}

	public processLoadConfig(msg: GG.ResponseLoadConfig) {
		this.currentRepoRefreshState.requestingConfig = false;
		if (msg.config !== null && this.currentRepo === msg.repo) {
			this.gitConfig = msg.config;
			this.saveState();

			this.renderCdvExternalDiffBtn();
		}
		this.settingsWidget.refresh();
	}

	private displayLoadDataError(message: string, reason: string) {
		this.clearCommits();
		this.currentRepoRefreshState.inProgress = false;
		this.loadViewTo = null;
		this.renderRefreshButton();
		dialog.showError(message, reason, t('Retry'), () => {
			this.refresh(true);
		});
	}

	public loadAvatar(email: string, image: string) {
		this.avatars[email] = image;
		this.saveState();
		let avatarsElems = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName('avatar'), escapedEmail = escapeHtml(email);
		for (let i = 0; i < avatarsElems.length; i++) {
			if (avatarsElems[i].dataset.email === escapedEmail) {
				avatarsElems[i].innerHTML = '<img class="avatarImg" src="' + image + '">';
			}
		}
	}


	/* Getters */

	public getBranches(): ReadonlyArray<string> {
		return this.gitBranches;
	}

	public getBranchOptions(includeShowAll?: boolean): ReadonlyArray<DialogSelectInputOption> {
		const options: DialogSelectInputOption[] = [];
		if (includeShowAll) {
			options.push({ name: t('Show All'), value: SHOW_ALL_BRANCHES });
		}
		for (let i = 0; i < this.config.customBranchGlobPatterns.length; i++) {
			options.push({ name: 'Glob: ' + this.config.customBranchGlobPatterns[i].name, value: this.config.customBranchGlobPatterns[i].glob });
		}
		for (let i = 0; i < this.gitBranches.length; i++) {
			options.push({ name: this.gitBranches[i].indexOf('remotes/') === 0 ? this.gitBranches[i].substring(8) : this.gitBranches[i], value: this.gitBranches[i] });
		}
		return options;
	}

	/**
	 * Add the authors of the loaded commits to the authors that can be selected in the Authors Dropdown (the authors of all commits loaded in the repository during this session are retained, so that the filter can be changed while it's active).
	 */
	private updateKnownAuthors() {
		const authors = new Set(this.knownAuthors);
		if (this.currentAuthors !== null) {
			this.currentAuthors.forEach((author) => {
				if (author !== SHOW_ALL_BRANCHES) authors.add(author);
			});
		}
		this.commits.forEach((commit) => {
			if (commit.hash !== UNCOMMITTED && commit.author !== '') authors.add(commit.author);
		});
		if (authors.size !== this.knownAuthors.length) {
			this.knownAuthors = Array.from(authors).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
			this.saveState();
		}
		this.renderAuthorDropdown();
	}

	private renderAuthorDropdown() {
		// The number of loaded commits by each author (only known for the authors whose commits are loaded)
		const counts: { [author: string]: number } = {};
		this.loadedCommits.forEach((commit) => {
			if (commit.hash !== UNCOMMITTED && commit.stash === null) counts[commit.author] = (counts[commit.author] || 0) + 1;
		});
		const authorsLoaded = (author: string) => this.currentAuthors === null || this.currentAuthors.includes(SHOW_ALL_BRANCHES) || this.currentAuthors.includes(author);
		this.authorDropdown.setOptions(
			[<DropdownOption>{ name: t('Show All'), value: SHOW_ALL_BRANCHES }].concat(this.knownAuthors.map((author) => ({
				name: author,
				value: author,
				icon: generateAuthorInitialHtml(author, true),
				count: authorsLoaded(author) ? counts[author] || 0 : undefined
			}))),
			this.currentAuthors === null ? [SHOW_ALL_BRANCHES] : this.currentAuthors
		);
	}

	public getCommitId(hash: string) {
		return typeof this.commitLookup[hash] === 'number' ? this.commitLookup[hash] : null;
	}

	private getCommitOfElem(elem: HTMLElement) {
		let id = parseInt(elem.dataset.id!);
		return id < this.commits.length ? this.commits[id] : null;
	}

	public getCommits(): ReadonlyArray<GG.GitCommit> {
		return this.commits;
	}

	private getPushRemote(branch: string | null = null) {
		const possibleRemotes = [];
		if (this.gitConfig !== null) {
			if (branch !== null && typeof this.gitConfig.branches[branch] !== 'undefined') {
				possibleRemotes.push(this.gitConfig.branches[branch].pushRemote, this.gitConfig.branches[branch].remote);
			}
			possibleRemotes.push(this.gitConfig.pushDefault);
		}
		possibleRemotes.push('origin');
		return possibleRemotes.find((remote) => remote !== null && this.gitRemotes.includes(remote)) || this.gitRemotes[0];
	}

	public getRepoConfig(): Readonly<GG.GitRepoConfig> | null {
		return this.gitConfig;
	}

	public getRepoState(repo: string): Readonly<GG.GitRepoState> | null {
		return typeof this.gitRepos[repo] !== 'undefined'
			? this.gitRepos[repo]
			: null;
	}

	public isConfigLoading(): boolean {
		return this.currentRepoRefreshState.requestingConfig;
	}


	/* Refresh */

	public refresh(hard: boolean, configChanges: boolean = false) {
		if (hard) {
			this.clearCommits();
		}
		this.requestLoadRepoInfoAndCommits(hard, false, configChanges);
	}


	/* Requests */

	private requestLoadRepoInfo() {
		const repoState = this.gitRepos[this.currentRepo];
		sendMessage({
			command: 'loadRepoInfo',
			repo: this.currentRepo,
			refreshId: ++this.currentRepoRefreshState.loadRepoInfoRefreshId,
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
			showStashes: getShowStashes(repoState.showStashes),
			hideRemotes: repoState.hideRemotes
		});
	}

	private requestLoadCommits() {
		const repoState = this.gitRepos[this.currentRepo];
		sendMessage({
			command: 'loadCommits',
			repo: this.currentRepo,
			refreshId: ++this.currentRepoRefreshState.loadCommitsRefreshId,
			branches: this.currentBranches === null || (this.currentBranches.length === 1 && this.currentBranches[0] === SHOW_ALL_BRANCHES) ? null : this.currentBranches,
			maxCommits: this.maxCommits,
			showTags: getShowTags(repoState.showTags),
			showRemoteBranches: getShowRemoteBranches(repoState.showRemoteBranchesV2),
			includeCommitsMentionedByReflogs: getIncludeCommitsMentionedByReflogs(repoState.includeCommitsMentionedByReflogs),
			onlyFollowFirstParent: getOnlyFollowFirstParent(repoState.onlyFollowFirstParent),
			commitOrdering: getCommitOrdering(repoState.commitOrdering),
			remotes: this.gitRemotes,
			hideRemotes: repoState.hideRemotes,
			stashes: this.gitStashes,
			authors: this.currentAuthors === null || this.currentAuthors.includes(SHOW_ALL_BRANCHES) ? null : this.currentAuthors,
			filePath: this.fileHistory
		});
	}

	private requestLoadRepoInfoAndCommits(hard: boolean, skipRepoInfo: boolean, configChanges: boolean = false) {
		const refreshState = this.currentRepoRefreshState;
		if (refreshState.inProgress) {
			refreshState.hard = refreshState.hard || hard;
			refreshState.configChanges = refreshState.configChanges || configChanges;
			if (!skipRepoInfo) {
				// This request will trigger a loadCommit request after the loadRepoInfo request has completed.
				// Invalidate any previous commit requests in progress.
				refreshState.loadCommitsRefreshId++;
			}
		} else {
			refreshState.hard = hard;
			refreshState.inProgress = true;
			refreshState.repoInfoChanges = false;
			refreshState.configChanges = configChanges;
			refreshState.requestingRepoInfo = false;
		}

		this.renderRefreshButton();
		if (this.commits.length === 0) {
			this.tableElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + t('Loading ...') + '</h2>';
		}

		if (skipRepoInfo) {
			if (!refreshState.requestingRepoInfo) {
				this.requestLoadCommits();
			}
		} else {
			refreshState.requestingRepoInfo = true;
			this.requestLoadRepoInfo();
		}
	}

	public requestLoadConfig() {
		this.currentRepoRefreshState.requestingConfig = true;
		sendMessage({ command: 'loadConfig', repo: this.currentRepo, remotes: this.gitRemotes });
		this.settingsWidget.refresh();
	}

	public requestCommitDetails(hash: string, refresh: boolean) {
		let commit = this.commits[this.commitLookup[hash]];
		sendMessage({
			command: 'commitDetails',
			repo: this.currentRepo,
			commitHash: hash,
			hasParents: commit.parents.length > 0,
			stash: commit.stash,
			avatarEmail: this.config.fetchAvatars && hash !== UNCOMMITTED ? commit.email : null,
			refresh: refresh
		});
	}

	public requestCommitComparison(hash: string, compareWithHash: string, refresh: boolean) {
		let commitOrder = this.getCommitOrder(hash, compareWithHash);
		sendMessage({
			command: 'compareCommits',
			repo: this.currentRepo,
			commitHash: hash, compareWithHash: compareWithHash,
			fromHash: commitOrder.from, toHash: commitOrder.to,
			refresh: refresh
		});
	}

	private requestAvatars(avatars: { [email: string]: string[] }) {
		let emails = Object.keys(avatars), remote = this.gitRemotes.length > 0 ? this.gitRemotes.includes('origin') ? 'origin' : this.gitRemotes[0] : null;
		for (let i = 0; i < emails.length; i++) {
			sendMessage({ command: 'fetchAvatar', repo: this.currentRepo, remote: remote, email: emails[i], commits: avatars[emails[i]] });
		}
	}


	/* State */

	public saveState() {
		let expandedCommit;
		if (this.expandedCommit !== null) {
			expandedCommit = Object.assign({}, this.expandedCommit);
			expandedCommit.commitElem = null;
			expandedCommit.compareWithElem = null;
			expandedCommit.contextMenuOpen = {
				summary: false,
				fileView: -1
			};
		} else {
			expandedCommit = null;
		}

		VSCODE_API.setState({
			currentRepo: this.currentRepo,
			currentRepoLoading: this.currentRepoLoading,
			gitRepos: this.gitRepos,
			gitBranches: this.gitBranches,
			gitBranchHead: this.gitBranchHead,
			gitConfig: this.gitConfig,
			gitRemotes: this.gitRemotes,
			gitStashes: this.gitStashes,
			gitUpstreams: this.gitUpstreams,
			gitTags: this.gitTags,
			commits: this.loadedCommits,
			fileHistory: this.fileHistory,
			fileHistoryData: this.fileHistoryData,
			commitHead: this.commitHead,
			avatars: this.avatars,
			currentBranches: this.currentBranches,
			currentAuthors: this.currentAuthors,
			knownAuthors: this.knownAuthors,
			moreCommitsAvailable: this.moreCommitsAvailable,
			maxCommits: this.maxCommits,
			onlyFollowFirstParent: this.onlyFollowFirstParent,
			expandedCommit: expandedCommit,
			scrollTop: this.scrollTop,
			findWidget: this.findWidget.getState(),
			settingsWidget: this.settingsWidget.getState()
		});
	}

	public saveRepoState() {
		sendMessage({ command: 'setRepoState', repo: this.currentRepo, state: this.gitRepos[this.currentRepo] });
	}

	private saveColumnWidths(columnWidths: GG.ColumnWidth[]) {
		this.gitRepos[this.currentRepo].columnWidths = [columnWidths[0], columnWidths[2], columnWidths[3], columnWidths[4]];
		this.saveRepoState();
	}

	private saveExpandedCommitLoading(index: number, commitHash: string, commitElem: HTMLElement, compareWithHash: string | null, compareWithElem: HTMLElement | null) {
		this.expandedCommit = {
			index: index,
			commitHash: commitHash,
			commitElem: commitElem,
			compareWithHash: compareWithHash,
			compareWithElem: compareWithElem,
			commitDetails: null,
			fileChanges: null,
			fileTree: null,
			avatar: null,
			codeReview: null,
			lastViewedFile: null,
			loading: true,
			scrollTop: {
				summary: 0,
				fileView: 0
			},
			contextMenuOpen: {
				summary: false,
				fileView: -1
			}
		};
		this.saveState();
	}

	/**
	 * Show or hide the remote branches (from the Repository Settings Widget, keeping the control bar's checkbox in sync).
	 * @param show TRUE => Show the remote branches, FALSE => Hide the remote branches.
	 */
	public setShowRemoteBranches(show: boolean) {
		if (this.showRemoteBranchesElem.checked === show) return;
		this.showRemoteBranchesElem.checked = show;
		this.saveRepoStateValue(this.currentRepo, 'showRemoteBranchesV2', show ? GG.BooleanOverride.Enabled : GG.BooleanOverride.Disabled);
		this.refresh(true);
	}

	public saveRepoStateValue<K extends keyof GG.GitRepoState>(repo: string, key: K, value: GG.GitRepoState[K]) {
		if (repo === this.currentRepo) {
			this.gitRepos[this.currentRepo][key] = value;
			this.saveRepoState();
		}
	}


	/* Renderers */

	private render() {
		this.renderTable();
		this.renderGraph();
		this.renderOverviews();
	}

	/**
	 * Render the overviews of the loaded commits: the Minimap, and the markers alongside the scrollbar.
	 */
	private renderOverviews() {
		this.minimap.render(this.commits, this.commitHead, this.graph.getVertexColours(), this.config.graph.colours, this.config.graph.minimap);
		this.updateMinimapViewport();
		this.renderScrollMarkers();
	}

	public renderScrollMarkers() {
		this.scrollMarkers.render(this.commits, this.commitHead, this.graph.getVertexColours(), this.config.graph.colours, this.findWidget.getMatchHashes());
	}

	/**
	 * Show the commits that are visible in the view on the Minimap.
	 */
	private updateMinimapViewport() {
		const commitElems = getCommitElems();
		if (commitElems.length === 0) return;
		const viewRect = this.viewElem.getBoundingClientRect(), top = viewRect.top + this.controlsElem.offsetHeight, bottom = viewRect.bottom;
		let low = 0, high = commitElems.length - 1, first = commitElems.length - 1, last: number;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (commitElems[mid].getBoundingClientRect().bottom > top) {
				first = mid;
				high = mid - 1;
			} else {
				low = mid + 1;
			}
		}
		low = first;
		high = commitElems.length - 1;
		last = first;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (commitElems[mid].getBoundingClientRect().top < bottom) {
				last = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		this.minimap.setViewport(parseInt(commitElems[first].dataset.id!), parseInt(commitElems[last].dataset.id!));
	}

	/**
	 * Keep the Minimap's viewport and the scrollbar markers up to date as the view is scrolled & resized.
	 */
	private observeOverviews() {
		let viewportFrame: number | null = null, markersFrame: number | null = null;
		this.viewElem.addEventListener('scroll', () => {
			if (viewportFrame !== null) return;
			viewportFrame = requestAnimationFrame(() => {
				viewportFrame = null;
				this.updateMinimapViewport();
			});
		});
		const resizeObserver = new ResizeObserver(() => {
			document.body.style.setProperty('--git-graph-headerHeight', this.controlsElem.offsetHeight + 'px');
			if (markersFrame !== null) return;
			markersFrame = requestAnimationFrame(() => {
				markersFrame = null;
				this.updateMinimapViewport();
				this.renderScrollMarkers();
			});
		});
		resizeObserver.observe(this.viewElem);
		resizeObserver.observe(this.controlsElem);
		resizeObserver.observe(document.getElementById('content')!);
	}

	private renderGraph() {
		if (typeof this.currentRepo === 'undefined') {
			// Only render the graph if a repo is loaded (or a repo is currently being loaded)
			return;
		}

		const colHeadersElem = document.getElementById('tableColHeaders');
		const cdvHeight = this.gitRepos[this.currentRepo].cdvHeight;
		const headerHeight = colHeadersElem !== null ? colHeadersElem.clientHeight + 1 : 0;
		const expandedCommit = this.isCdvDocked() ? null : this.expandedCommit;
		const expandedCommitElem = expandedCommit !== null ? document.getElementById('cdv') : null;

		// Update the graphs grid dimensions
		this.config.graph.grid.expandY = expandedCommitElem !== null
			? expandedCommitElem.getBoundingClientRect().height
			: cdvHeight;
		this.config.graph.grid.y = this.commits.length > 0 && this.tableElem.children.length > 0
			? (this.tableElem.children[0].clientHeight - headerHeight - (expandedCommit !== null ? cdvHeight : 0)) / this.commits.length
			: this.config.graph.grid.y;
		this.config.graph.grid.offsetY = headerHeight + this.config.graph.grid.y / 2;

		this.graph.render(expandedCommit);
	}

	private renderTable() {
		const colVisibility = this.getColumnVisibility();
		const currentHash = this.commits.length > 0 && this.commits[0].hash === UNCOMMITTED ? UNCOMMITTED : this.commitHead;
		const vertexColours = this.graph.getVertexColours();
		const widthsAtVertices = this.config.referenceLabels.branchLabelsAlignedToGraph ? this.graph.getWidthsAtVertices() : [];
		const mutedCommits = this.graph.getMutedCommits(currentHash);
		const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
			emoji: true,
			issueLinking: true,
			markdown: this.config.markdown
		});

		const fileHistory = this.fileHistory !== null ? (this.fileHistoryData !== null ? this.fileHistoryData.commits : {}) : null;
		let maxLinesChanged = 1;
		if (fileHistory !== null) {
			Object.keys(fileHistory).forEach((hash) => maxLinesChanged = Math.max(maxLinesChanged, (fileHistory[hash].additions || 0) + (fileHistory[hash].deletions || 0)));
		}

		const refsInColumn = this.config.referenceLabels.inSeparateColumn, showChanges = this.isChangesColumnShown();
		alterClass(document.body, 'refsColumn', refsInColumn);
		const headers = [
			'<th id="tableHeaderGraphCol" class="tableColHeader graphCol" data-col="0">' + t('Graph') + '</th>',
			'<th class="tableColHeader descriptionCol" data-col="1">' + t('Description') + '</th>'
		];
		if (refsInColumn) headers.unshift('<th class="refsCol">' + t('Branches / Tags') + '</th>');
		if (colVisibility.date) headers.push('<th class="tableColHeader dateCol" data-col="2">' + t('Date') + '</th>');
		if (colVisibility.author) headers.push('<th class="tableColHeader authorCol" data-col="3">' + t('Author') + '</th>');
		if (fileHistory !== null) {
			headers.push('<th class="fileChangesCol">' + t('Changes to this File') + '</th>');
		} else if (showChanges) {
			headers.push('<th class="changesCol">' + t('Changes') + '</th>');
		}
		if (colVisibility.commit) headers.push('<th class="tableColHeader" data-col="4">' + t('Commit') + '</th>');
		// The button to choose the columns is in the last column header
		headers[headers.length - 1] = headers[headers.length - 1].replace(/<\/th>$/, '<span id="columnSettingsBtn" title="' + t('Choose the columns that are shown') + '">' + SVG_ICONS.columns + '</span></th>');
		let html = '<tr id="tableColHeaders">' + headers.join('') + '</tr>';

		for (let i = 0; i < this.commits.length; i++) {
			let commit = this.commits[i];
			const fileChange = fileHistory !== null ? fileHistory[commit.hash] : undefined;
			let message = (typeof fileChange !== 'undefined' && fileChange.oldFilePath !== null ? '<span class="fileHistoryRenamed" title="' + escapeHtml(fileChange.oldFilePath + ' \u2192 ' + fileChange.filePath) + '">\u21aa ' + t('Renamed from {0}', escapeHtml(fileChange.oldFilePath)) + '</span>' : '') + '<span class="text">' + textFormatter.format(commit.message) + '</span>';
			let date = formatShortDate(commit.date);
			let branchLabels = getBranchLabels(commit.heads, commit.remotes);
			let refBranches = '', refTags = '', j, k, refName, remoteName, refActive, refHtml, branchCheckedOutAtCommit: string | null = null;

			for (j = 0; j < branchLabels.heads.length; j++) {
				refName = escapeHtml(branchLabels.heads[j].name);
				refActive = branchLabels.heads[j].name === this.gitBranchHead;
				refHtml = '<span class="gitRef head' + (refActive ? ' active' : '') + '" data-name="' + refName + '">' + (refActive && refsInColumn ? SVG_ICONS.check : SVG_ICONS.branch) + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span>';
				for (k = 0; k < branchLabels.heads[j].remotes.length; k++) {
					remoteName = escapeHtml(branchLabels.heads[j].remotes[k]);
					const remoteFullRef = escapeHtml(branchLabels.heads[j].remotes[k] + '/' + branchLabels.heads[j].name);
					refHtml += refsInColumn
						? '<span class="gitRefHeadRemote icon" data-remote="' + remoteName + '" data-fullref="' + remoteFullRef + '" title="' + t('{0} is at this commit', remoteFullRef) + '">' + SVG_ICONS.cloud + '</span>'
						: '<span class="gitRefHeadRemote" data-remote="' + remoteName + '" data-fullref="' + remoteFullRef + '">' + remoteName + '</span>';
				}
				refHtml += generateTrackingHtml(this.gitUpstreams[branchLabels.heads[j].name]) + '</span>';
				refBranches = refActive ? refHtml + refBranches : refBranches + refHtml;
				if (refActive) branchCheckedOutAtCommit = this.gitBranchHead;
			}
			for (j = 0; j < branchLabels.remotes.length; j++) {
				refName = escapeHtml(branchLabels.remotes[j].name);
				refBranches += '<span class="gitRef remote" data-name="' + refName + '" data-remote="' + (branchLabels.remotes[j].remote !== null ? escapeHtml(branchLabels.remotes[j].remote!) : '') + '">' + (refsInColumn ? SVG_ICONS.cloud : SVG_ICONS.branch) + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span></span>';
			}

			for (j = 0; j < commit.tags.length; j++) {
				refName = escapeHtml(commit.tags[j].name);
				refTags += '<span class="gitRef tag" data-name="' + refName + '" data-tagtype="' + (commit.tags[j].annotated ? 'annotated' : 'lightweight') + '">' + SVG_ICONS.tag + '<span class="gitRefName" data-fullref="' + refName + '">' + refName + '</span></span>';
			}

			if (commit.stash !== null) {
				refName = escapeHtml(commit.stash.selector);
				refBranches = '<span class="gitRef stash" data-name="' + refName + '">' + SVG_ICONS.stash + '<span class="gitRefName" data-fullref="' + refName + '">' + escapeHtml(commit.stash.selector.substring(5)) + '</span></span>' + refBranches;
			}

			const commitDot = commit.hash === this.commitHead
				? '<span class="commitHeadDot" title="' + (branchCheckedOutAtCommit !== null
					? t('The branch {0} is currently checked out at this commit', escapeHtml('"' + branchCheckedOutAtCommit + '"'))
					: t('This commit is currently checked out')
				) + '."></span>'
				: '';

			html += '<tr class="commit' + (commit.hash === currentHash ? ' current' : '') + (mutedCommits[i] ? ' mute' : '') + '"' + (commit.hash !== UNCOMMITTED ? '' : ' id="uncommittedChanges"') + ' data-id="' + i + '" data-color="' + vertexColours[i] + '">' +
				(refsInColumn
					? '<td class="refsCol">' + (refBranches !== '' || refTags !== '' ? '<span class="refsColLabels">' + refBranches + refTags + '</span>' : '') + '</td><td class="graphCol"></td><td class="descriptionCol"><span class="description">' + commitDot + message
					: this.config.referenceLabels.branchLabelsAlignedToGraph
						? '<td class="graphCol">' + (refBranches !== '' ? '<span style="margin-left:' + (widthsAtVertices[i] - 4) + 'px"' + refBranches.substring(5) : '') + '</td><td class="descriptionCol"><span class="description">' + commitDot + (this.config.referenceLabels.tagLabelsOnRight ? message + refTags : refTags + message)
						: '<td class="graphCol"></td><td class="descriptionCol"><span class="description">' + commitDot + refBranches + (this.config.referenceLabels.tagLabelsOnRight ? message + refTags : refTags + message)) + '</span></td>' +
				(colVisibility.date ? '<td class="dateCol text" title="' + date.title + '">' + date.formatted + '</td>' : '') +
				(colVisibility.author ? '<td class="authorCol text" title="' + escapeHtml(commit.author + ' <' + commit.email + '>') + '">' + (this.config.fetchAvatars ? '<span class="avatar" data-email="' + escapeHtml(commit.email) + '">' + (typeof this.avatars[commit.email] === 'string' ? '<img class="avatarImg" src="' + this.avatars[commit.email] + '">' : '') + '</span>' : generateAuthorInitialHtml(commit.author)) + escapeHtml(commit.author) + '</td>' : '') +
				(fileHistory !== null ? '<td class="fileChangesCol">' + (typeof fileChange !== 'undefined'
					? (fileChange.additions !== null && fileChange.deletions !== null
						? generateChangeBarHtml(fileChange.additions, fileChange.deletions, Math.round(8 + 52 * (fileChange.additions + fileChange.deletions) / maxLinesChanged)) + '<span class="fileTreeFileAdd">+' + fileChange.additions + '</span><span class="fileTreeFileDel">\u2212' + fileChange.deletions + '</span>'
						: '<span class="fileChangesBinary">' + t('Binary') + '</span>')
					: '') + '</td>' : showChanges ? '<td class="changesCol">' + (commit.stash === null && typeof this.commitStats[commit.hash] !== 'undefined' ? generateCommitStatsHtml(this.commitStats[commit.hash]) : '') + '</td>' : '') +
				(colVisibility.commit ? '<td class="hashCol text" title="' + escapeHtml(commit.hash) + '">' + abbrevCommit(commit.hash) + '</td>' : '') +
				'</tr>';
		}
		this.tableElem.innerHTML = '<table>' + html + '</table>';
		const countCommits = (commits: ReadonlyArray<GG.GitCommit>) => commits.filter((commit) => commit.hash !== UNCOMMITTED && commit.stash === null).length;
		const loaded = countCommits(this.loadedCommits), shown = countCommits(this.commits);
		this.footerElem.innerHTML = this.commits.length > 0
			? '<div id="listFooter"><span class="listFooterCount">' + (loaded !== 1 ? t('{0} commits loaded', loaded) : t('1 commit loaded')) + (shown !== loaded ? ' · ' + t('{0} shown', shown) : '') + '</span>' +
				'<span class="listFooterLegend">' + t('Scrollbar markers:') + '<span><i style="background-color:var(--vscode-focusBorder)"></i>HEAD</span><span><i style="background-color:' + escapeHtml(this.config.graph.colours[1 % this.config.graph.colours.length]) + '"></i>' + t('Branches') + '</span><span><i style="background-color:var(--vscode-descriptionForeground)"></i>' + t('Tags') + '</span><span><i style="background-color:var(--vscode-editorOverviewRuler-findMatchForeground, #d18616)"></i>' + t('Find Matches') + '</span></span>' +
				'<span class="listFooterSpacer"></span>' + (this.moreCommitsAvailable ? '<div id="loadMoreCommitsBtn" class="roundedBtn">' + t('Load More Commits') + '</div>' : '') + '</div>'
			: '';
		this.makeTableResizable();
		this.fitRefLabels();
		const columnSettingsBtn = document.getElementById('columnSettingsBtn');
		if (columnSettingsBtn !== null) {
			columnSettingsBtn.addEventListener('click', (e) => {
				handledEvent(e); // Don't let the click propagate to the document, which closes context menus
				const bounds = columnSettingsBtn.getBoundingClientRect();
				document.getElementById('tableColHeaders')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: bounds.left, clientY: bounds.bottom }));
			});
		}
		this.findWidget.refresh();
		this.renderedGitBranchHead = this.gitBranchHead;

		if (this.moreCommitsAvailable) {
			document.getElementById('loadMoreCommitsBtn')!.addEventListener('click', () => {
				this.loadMoreCommits();
			});
		}

		if (this.expandedCommit !== null) {
			const expandedCommit = this.expandedCommit, elems = getCommitElems();
			const commitElem = findCommitElemWithId(elems, this.getCommitId(expandedCommit.commitHash));
			const compareWithElem = expandedCommit.compareWithHash !== null ? findCommitElemWithId(elems, this.getCommitId(expandedCommit.compareWithHash)) : null;

			if (commitElem === null || (expandedCommit.compareWithHash !== null && compareWithElem === null)) {
				this.closeCommitDetails(false);
				this.saveState();
			} else {
				expandedCommit.index = parseInt(commitElem.dataset.id!);
				expandedCommit.commitElem = commitElem;
				expandedCommit.compareWithElem = compareWithElem;
				this.saveState();
				if (expandedCommit.compareWithHash === null) {
					// Commit Details View is open
					if (!expandedCommit.loading && expandedCommit.commitDetails !== null && expandedCommit.fileTree !== null) {
						this.showCommitDetails(expandedCommit.commitDetails, expandedCommit.fileTree, expandedCommit.avatar, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED) {
							this.requestCommitDetails(expandedCommit.commitHash, true);
						}
					} else {
						this.loadCommitDetails(commitElem);
					}
				} else {
					// Commit Comparison is open
					if (!expandedCommit.loading && expandedCommit.fileChanges !== null && expandedCommit.fileTree !== null) {
						this.showCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, expandedCommit.fileChanges, expandedCommit.fileTree, expandedCommit.codeReview, expandedCommit.lastViewedFile, true);
						if (expandedCommit.commitHash === UNCOMMITTED || expandedCommit.compareWithHash === UNCOMMITTED) {
							this.requestCommitComparison(expandedCommit.commitHash, expandedCommit.compareWithHash, true);
						}
					} else {
						this.loadCommitComparison(commitElem, compareWithElem!);
					}
				}
			}
		}
	}

	private renderUncommittedChanges() {
		const rowElem = document.getElementById('uncommittedChanges');
		if (rowElem === null) return;
		const date = formatShortDate(this.commits[0].date), textElem = rowElem.querySelector('.description .text'), dateElem = <HTMLElement | null>rowElem.querySelector('.dateCol');
		if (textElem !== null) textElem.textContent = this.commits[0].message;
		if (dateElem !== null) {
			dateElem.title = date.title;
			dateElem.textContent = date.formatted;
		}
		this.requestCommitStats(true);
	}

	/**
	 * Fit the labels in the Branches / Tags column of each commit: the first (most important) label is shown in full, and the labels that
	 * don't fit are hidden, and counted on a "+N" label (whose tooltip lists them).
	 */
	private fitRefLabels() {
		this.tableElem.querySelectorAll<HTMLElement>('.refsColLabels').forEach((container) => {
			const labels = <HTMLElement[]>Array.from(container.children);
			if (labels.length < 2 || container.scrollWidth <= container.clientWidth + 1) return;
			const moreElem = document.createElement('span'), hidden: string[] = [];
			moreElem.className = 'refsColMore';
			container.appendChild(moreElem);
			for (let i = labels.length - 1; i > 0 && (hidden.length === 0 || container.scrollWidth > container.clientWidth + 1); i--) {
				labels[i].classList.add('hidden');
				const nameElem = labels[i].querySelector('.gitRefName');
				hidden.unshift(nameElem !== null ? nameElem.textContent! : '');
				moreElem.textContent = '+' + hidden.length;
			}
			moreElem.title = hidden.join('\n');
		});
	}

	/**
	 * Is the Changes column (the files & lines changed by each commit) shown.
	 * @returns TRUE => The column is shown, FALSE => The column isn't shown (e.g. the history of a file is shown, which has its own column).
	 */
	private isChangesColumnShown() {
		return this.fileHistory === null && this.gitRepos[this.currentRepo].showChangesColumn !== false;
	}

	/**
	 * Request the files & lines changed by the commits that are shown, which haven't been loaded.
	 * @param refreshUncommitted Should the stats of the uncommitted changes be refreshed (as they may have changed).
	 */
	private requestCommitStats(refreshUncommitted: boolean) {
		if (!this.isChangesColumnShown()) return;
		if (refreshUncommitted) {
			delete this.commitStats[UNCOMMITTED];
			this.commitStatsRequested.delete(UNCOMMITTED);
		}
		const hashes = this.commits.filter((commit) => commit.stash === null && typeof this.commitStats[commit.hash] === 'undefined' && !this.commitStatsRequested.has(commit.hash)).map((commit) => commit.hash);
		if (hashes.length === 0) return;
		hashes.forEach((hash) => this.commitStatsRequested.add(hash));
		sendMessage({ command: 'loadCommitStats', repo: this.currentRepo, hashes: hashes });
	}

	/**
	 * Process the files & lines changed by commits, loaded by the extension.
	 * @param msg The message containing the stats.
	 */
	public processLoadCommitStatsResponse(msg: GG.ResponseLoadCommitStats) {
		const commitElems = getCommitElems();
		Object.keys(msg.stats).forEach((hash) => {
			this.commitStats[hash] = msg.stats[hash];
			this.commitStatsRequested.delete(hash);
			const elem = findCommitElemWithId(commitElems, this.getCommitId(hash));
			const cellElem = elem !== null ? elem.querySelector('td.changesCol') : null;
			if (cellElem !== null) cellElem.innerHTML = generateCommitStatsHtml(this.commitStats[hash]);
		});
	}

	private renderFetchButton() {
		alterClass(this.controlsElem, CLASS_FETCH_SUPPORTED, this.gitRemotes.length > 0);
	}

	/**
	 * Render the Pull & Push buttons in the control bar, with the number of commits the current branch is behind / ahead of its upstream branch.
	 * @param branchHead The current branch (NULL if HEAD is detached).
	 */
	private renderSyncButtons(branchHead: string | null = this.gitBranchHead) {
		const pullBtn = document.getElementById('pullBtn')!, pushBtn = document.getElementById('pushBtn')!;
		const upstream = branchHead !== null && typeof this.gitUpstreams[branchHead] !== 'undefined' && !this.gitUpstreams[branchHead].gone ? this.gitUpstreams[branchHead] : null;
		const behind = upstream !== null ? upstream.behind : 0, ahead = upstream !== null ? upstream.ahead : 0;

		pullBtn.innerHTML = SVG_ICONS.pull + '<span>' + t('Pull') + '</span>' + (behind > 0 ? '<span class="syncCount">' + behind + '</span>' : '');
		pullBtn.title = upstream !== null
			? (behind > 0 ? t('Pull {0} commit(s) from {1} into the current branch', behind, upstream.name) : t('Pull {0} into the current branch', upstream.name))
			: t('The current branch doesn\'t have an upstream branch to pull from');
		alterClass(pullBtn, CLASS_DISABLED, upstream === null);

		pushBtn.innerHTML = SVG_ICONS.push + '<span>' + t('Push') + '</span>' + (ahead > 0 ? '<span class="syncCount">' + ahead + '</span>' : '');
		pushBtn.title = branchHead === null
			? t('HEAD is detached, so there isn\'t a branch to push')
			: ahead > 0 ? t('Push {0} unpushed commit(s) on {1}', ahead, branchHead) : t('Push {0}', branchHead) + ELLIPSIS;
		alterClass(pushBtn, CLASS_DISABLED, branchHead === null);
		alterClass(pushBtn, 'pending', ahead > 0);
	}

	/**
	 * Render the Stashes button in the control bar (shown when the repository has stashes).
	 */
	private renderStashButton() {
		const stashBtn = document.getElementById('stashBtn')!, count = this.gitStashes.length;
		stashBtn.innerHTML = SVG_ICONS.stashes + '<span class="pillLabel">' + t('Stashes') + '</span><span class="pillValue">' + count + '</span>' + SVG_ICONS.chevron;
		stashBtn.title = t('View the stashes in this repository');
		alterClass(stashBtn, 'hidden', count === 0);
	}

	/**
	 * Show (or hide) the list of the stashes in the repository below the Stashes button.
	 * @param stashBtn The Stashes button.
	 * @param e The click event on the Stashes button.
	 */
	private showStashList(stashBtn: HTMLElement, e: Event) {
		handledEvent(e); // Don't let the click propagate to the document, which closes the list
		if (document.getElementById('stashList') !== null) {
			this.closeStashList();
			return;
		}
		closeDialogAndContextMenu();
		const listElem = document.createElement('div');
		listElem.id = 'stashList';
		const bounds = stashBtn.getBoundingClientRect();
		listElem.style.left = Math.max(Math.min(bounds.left, window.innerWidth - 572), 8) + 'px';
		listElem.style.top = (bounds.bottom + 6) + 'px';
		document.body.appendChild(listElem);
		stashBtn.classList.add(CLASS_ACTIVE);
		this.renderStashList();

		// Request the stats of the stashes that haven't been loaded
		const stashes = this.gitStashes.filter((stash) => typeof this.stashStats[stash.hash] === 'undefined');
		if (stashes.length > 0) {
			sendMessage({ command: 'loadStashStats', repo: this.currentRepo, stashes: stashes.map((stash) => ({ hash: stash.hash, baseHash: stash.baseHash, untrackedFilesHash: stash.untrackedFilesHash })) });
		}

		listElem.addEventListener('click', (e) => {
			handledEvent(e);
			const target = <Element>e.target, itemElem = <HTMLElement | null>target.closest('.stashListItem');
			if (target.closest('#stashListStashChanges') !== null) {
				if (this.loadedCommits.length > 0 && this.loadedCommits[0].hash === UNCOMMITTED) {
					this.closeStashList();
					this.stashUncommittedChangesAction(null);
				}
				return;
			}
			if (itemElem === null) return;
			const stash = this.gitStashes[parseInt(itemElem.dataset.index!)];
			if (typeof stash === 'undefined') return;
			const actionElem = <HTMLElement | null>target.closest('.stashListAction');
			const rowElem = findCommitElemWithId(getCommitElems(), this.getCommitId(stash.hash));
			const dialogTarget: DialogTarget | null = rowElem !== null ? { type: TargetType.Ref, elem: rowElem, hash: stash.hash, ref: stash.selector } : null;
			this.closeStashList();
			if (actionElem === null) {
				this.goToStash(stash);
			} else if (actionElem.dataset.action === 'apply') {
				this.applyStashAction(stash.selector, dialogTarget);
			} else if (actionElem.dataset.action === 'pop') {
				this.popStashAction(stash.selector, dialogTarget);
			} else if (actionElem.dataset.action === 'drop') {
				this.dropStashAction(stash.selector, dialogTarget);
			}
		});
	}

	/**
	 * Render the list of the stashes in the repository (if it's open).
	 */
	private renderStashList() {
		const listElem = document.getElementById('stashList');
		if (listElem === null) return;
		const keybinding = this.config.keybindings.scrollToStash, isMac = /Mac/.test(navigator.platform), canStash = this.loadedCommits.length > 0 && this.loadedCommits[0].hash === UNCOMMITTED;
		const modifier = isMac ? '\u2318' : 'Ctrl+', shift = isMac ? '\u21e7' : 'Shift+';
		listElem.innerHTML = '<div class="stashListHeader"><b>' + t('Stashes') + ' · ' + this.gitStashes.length + '</b><span>' + t('Click on a stash to go to it on the graph, and open its details') + '</span></div>' +
			'<div class="stashListItems">' + this.gitStashes.map((stash, index) => {
			const stats = this.stashStats[stash.hash], branch = stash.message.match(/^(?:WIP on|On) ([^:]+):/);
			return '<div class="stashListItem" data-index="' + index + '"><span class="stashListSelector">' + escapeHtml(stash.selector.substring(5)) + '</span>' +
					'<span class="stashListMessage" title="' + escapeHtml(stash.message) + '">' + escapeHtml(stash.message) + '</span>' +
					'<span class="stashListActions"><button type="button" class="stashListAction primary" data-action="apply" tabindex="-1">' + t('Apply') + '</button><button type="button" class="stashListAction" data-action="pop" tabindex="-1">' + t('Pop') + '</button><button type="button" class="stashListAction danger" data-action="drop" tabindex="-1">' + t('Drop') + '</button></span>' +
					'<span class="stashListMeta">' + (branch !== null ? '<span>' + escapeHtml(branch[1]) + '</span>' : '') + '<span title="' + escapeHtml(formatLongDate(stash.date)) + '">' + escapeHtml(formatRelativeDate(stash.date)) + '</span>' +
					'<span>' + (typeof stats !== 'undefined'
				? (stats.files !== 1 ? t('{0} files', stats.files) : t('{0} file', stats.files)) + ' · <span class="fileTreeFileAdd">+' + stats.additions + '</span> <span class="fileTreeFileDel">\u2212' + stats.deletions + '</span>'
				: t('Loading') + ELLIPSIS) + '</span>' +
					(stash.untrackedFilesHash !== null ? '<span>' + t('Includes untracked files') + '</span>' : '') +
					(typeof this.commitLookup[stash.hash] !== 'number' ? '<span class="stashListNotLoaded">' + t('Not in the loaded commits') + '</span>' : '') +
					'</span></div>';
		}).join('') + '</div>' +
			'<div class="stashListFooter"><button type="button" id="stashListStashChanges" class="stashListAction' + (canStash ? '' : ' ' + CLASS_DISABLED) + '" title="' + (canStash ? t('Stash the uncommitted changes') : t('There aren\'t any uncommitted changes to stash')) + '" tabindex="-1">' + t('Stash Current Changes') + ELLIPSIS + '</button><span class="stashListSpacer"></span>' +
			(keybinding !== null ? '<span>' + t('{0} / {1}: go to the next / previous stash', modifier + keybinding.toUpperCase(), modifier + shift + keybinding.toUpperCase()) + '</span>' : '') + '</div>';
	}

	/**
	 * Close the list of the stashes in the repository (if it's open).
	 */
	public closeStashList() {
		const listElem = document.getElementById('stashList');
		if (listElem === null) return;
		listElem.remove();
		document.getElementById('stashBtn')!.classList.remove(CLASS_ACTIVE);
	}

	/**
	 * Is the list of the stashes in the repository open.
	 */
	public isStashListOpen() {
		return document.getElementById('stashList') !== null;
	}

	/**
	 * Process the stats of the stashes loaded by the extension.
	 * @param msg The message containing the stats.
	 */
	public processLoadStashStatsResponse(msg: GG.ResponseLoadStashStats) {
		Object.keys(msg.stats).forEach((hash) => this.stashStats[hash] = msg.stats[hash]);
		this.renderStashList();
	}

	/**
	 * Scroll to a stash on the graph, and open its Commit Details View. If the stash isn't in the loaded commits, more commits are loaded until it is.
	 * @param stash The stash.
	 */
	private goToStash(stash: GG.GitStash) {
		const elem = findCommitElemWithId(getCommitElems(), this.getCommitId(stash.hash));
		const attempts = this.scrollToStashPending !== null && this.scrollToStashPending.stash.hash === stash.hash ? this.scrollToStashPending.attempts : 0;
		if (elem !== null) {
			this.scrollToStashPending = null;
			this.scrollToCommit(stash.hash, true, true);
			if (!this.isCdvOpen(stash.hash, null)) this.loadCommitDetails(elem);
		} else if (this.moreCommitsAvailable && this.commitFilter === null && attempts < 10) {
			this.scrollToStashPending = { stash: stash, attempts: attempts + 1 };
			if (!this.currentRepoRefreshState.inProgress) this.loadMoreCommits();
		} else {
			this.scrollToStashPending = null;
			dialog.showMessage(t('The stash <b><i>{0}</i></b> isn\'t in the commits that are currently shown. Load more commits (or clear the search) to view it.', escapeHtml(stash.selector.substring(5))));
		}
	}

	/**
	 * Pull the upstream branch of the current branch into the current branch.
	 */
	private pullUpstreamAction() {
		const branchHead = this.gitBranchHead;
		if (branchHead === null || typeof this.gitUpstreams[branchHead] === 'undefined' || this.gitUpstreams[branchHead].gone) return;
		const upstream = this.gitUpstreams[branchHead].name;
		const remote = this.gitRemotes.filter((remote) => upstream.startsWith(remote + '/')).sort((a, b) => b.length - a.length)[0];
		if (typeof remote === 'undefined') return;
		this.pullBranchAction(upstream, remote, upstream.substring(remote.length + 1), null);
	}

	public renderRefreshButton() {
		const enabled = !this.currentRepoRefreshState.inProgress;
		this.refreshBtnElem.title = enabled ? t('Refresh') : t('Refreshing');
		this.refreshBtnElem.innerHTML = enabled ? SVG_ICONS.refresh : SVG_ICONS.loading;
		alterClass(this.refreshBtnElem, CLASS_REFRESHING, !enabled);
	}

	public renderTagDetails(tagName: string, commitHash: string, details: GG.GitTagDetails) {
		const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
			commits: true,
			emoji: true,
			issueLinking: true,
			markdown: this.config.markdown,
			multiline: true,
			urls: true
		});
		dialog.showMessage(
			t('Tag <b><i>{0}</i></b>', escapeHtml(tagName)) + '<br><span class="messageContent">' +
			'<b>' + t('Object:') + ' </b>' + escapeHtml(details.hash) + '<br>' +
			'<b>' + t('Commit:') + ' </b>' + escapeHtml(commitHash) + '<br>' +
			'<b>' + t('Tagger:') + ' </b>' + escapeHtml(details.taggerName) + ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(details.taggerEmail) + '" tabindex="-1">' + escapeHtml(details.taggerEmail) + '</a>&gt;' + (details.signature !== null ? generateSignatureHtml(details.signature) : '') + '<br>' +
			'<b>' + t('Date:') + ' </b>' + formatLongDate(details.taggerDate) + '<br><br>' +
			textFormatter.format(details.message) +
			'</span>'
		);
	}

	public renderRepoDropdownOptions(repo?: string) {
		this.repoDropdown.setOptions(getRepoDropdownOptions(this.gitRepos), [repo || this.currentRepo]);
	}


	/* Context Menu Generation */

	private getBranchContextMenuActions(target: DialogTarget & RefTarget): ContextMenuActions {
		const refName = target.ref, visibility = this.config.contextMenuActionsVisibility.branch;
		const isSelectedInBranchesDropdown = this.branchDropdown.isSelected(refName);
		return [[
			{
				title: t('Checkout Branch'),
				visible: visibility.checkout && this.gitBranchHead !== refName,
				onClick: () => this.checkoutBranchAction(refName, null, null, target)
			}, {
				title: t('Rename Branch') + ELLIPSIS,
				visible: visibility.rename,
				onClick: () => {
					dialog.showRefInput(t('Enter the new name for branch <b><i>{0}</i></b>:', escapeHtml(refName)), refName, t('Rename Branch'), (newName) => {
						runAction({ command: 'renameBranch', repo: this.currentRepo, oldName: refName, newName: newName }, t('Renaming Branch'));
					}, target);
				}
			}, {
				title: t('Delete Branch') + ELLIPSIS,
				visible: visibility.delete && this.gitBranchHead !== refName,
				onClick: () => {
					let remotesWithBranch = this.gitRemotes.filter(remote => this.gitBranches.includes('remotes/' + remote + '/' + refName));
					let inputs: DialogInput[] = [{ type: DialogInputType.Checkbox, name: t('Force Delete'), value: this.config.dialogDefaults.deleteBranch.forceDelete }];
					if (remotesWithBranch.length > 0) {
						inputs.push({
							type: DialogInputType.Checkbox,
							name: t('Delete this branch on the remote{0}', (this.gitRemotes.length > 1 ? 's' : '')),
							value: false,
							info: t('This branch is on the remote{0}{1}', (remotesWithBranch.length > 1 ? 's: ' : ' '), formatCommaSeparatedList(remotesWithBranch.map((remote) => '"' + remote + '"')))
						});
					}
					dialog.showForm(t('Are you sure you want to delete the branch <b><i>{0}</i></b>?', escapeHtml(refName)), inputs, t('Yes, delete'), (values) => {
						runAction({ command: 'deleteBranch', repo: this.currentRepo, branchName: refName, forceDelete: <boolean>values[0], deleteOnRemotes: remotesWithBranch.length > 0 && <boolean>values[1] ? remotesWithBranch : [] }, t('Deleting Branch'));
					}, target);
				}
			}, {
				title: t('Merge into current branch') + ELLIPSIS,
				visible: visibility.merge && this.gitBranchHead !== refName,
				onClick: () => this.mergeAction(refName, refName, GG.MergeActionOn.Branch, target)
			}, {
				title: t('Rebase current branch on Branch') + ELLIPSIS,
				visible: visibility.rebase && this.gitBranchHead !== refName,
				onClick: () => this.rebaseAction(refName, refName, GG.RebaseActionOn.Branch, target)
			}, {
				title: t('Push Branch') + ELLIPSIS,
				visible: visibility.push && this.gitRemotes.length > 0,
				onClick: () => this.pushBranchAction(refName, target)
			}
		], [
			this.getViewIssueAction(refName, visibility.viewIssue, target),
			{
				title: t('Create Pull Request') + ELLIPSIS,
				visible: visibility.createPullRequest && this.gitRepos[this.currentRepo].pullRequestConfig !== null,
				onClick: () => {
					const config = this.gitRepos[this.currentRepo].pullRequestConfig;
					if (config === null) return;
					dialog.showCheckbox(t('Are you sure you want to create a Pull Request for branch <b><i>{0}</i></b>?', escapeHtml(refName)), t('Push branch before creating the Pull Request'), true, t('Yes, create Pull Request'), (push) => {
						runAction({ command: 'createPullRequest', repo: this.currentRepo, config: config, sourceRemote: config.sourceRemote, sourceOwner: config.sourceOwner, sourceRepo: config.sourceRepo, sourceBranch: refName, push: push }, t('Creating Pull Request'));
					}, target);
				}
			}
		], [
			{
				title: t('Create Archive'),
				visible: visibility.createArchive,
				onClick: () => {
					runAction({ command: 'createArchive', repo: this.currentRepo, ref: refName }, t('Creating Archive'));
				}
			},
			{
				title: t('Select in Branches Dropdown'),
				visible: visibility.selectInBranchesDropdown && !isSelectedInBranchesDropdown,
				onClick: () => this.branchDropdown.selectOption(refName)
			},
			{
				title: t('Unselect in Branches Dropdown'),
				visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
				onClick: () => this.branchDropdown.unselectOption(refName)
			}
		], [
			{
				title: t('Copy Branch Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Branch Name'), data: refName });
				}
			}
		]];
	}

	private getCommitContextMenuActions(target: DialogTarget & CommitTarget): ContextMenuActions {
		const hash = target.hash, visibility = this.config.contextMenuActionsVisibility.commit;
		const commit = this.commits[this.commitLookup[hash]];
		return [[
			{
				title: t('Add Tag') + ELLIPSIS,
				visible: visibility.addTag,
				onClick: () => this.addTagAction(hash, '', this.config.dialogDefaults.addTag.type, '', null, target)
			}, {
				title: t('Create Branch') + ELLIPSIS,
				visible: visibility.createBranch,
				onClick: () => this.createBranchAction(hash, '', this.config.dialogDefaults.createBranch.checkout, target)
			}
		], [
			{
				title: t('Checkout') + (globalState.alwaysAcceptCheckoutCommit ? '' : ELLIPSIS),
				visible: visibility.checkout,
				onClick: () => {
					const checkoutCommit = () => runAction({ command: 'checkoutCommit', repo: this.currentRepo, commitHash: hash }, t('Checking out Commit'));
					if (globalState.alwaysAcceptCheckoutCommit) {
						checkoutCommit();
					} else {
						dialog.showCheckbox(t('Are you sure you want to checkout commit <b><i>{0}</i></b>? This will result in a \'detached HEAD\' state.', abbrevCommit(hash)), t('Always Accept'), false, t('Yes, checkout'), (alwaysAccept) => {
							if (alwaysAccept) {
								updateGlobalViewState('alwaysAcceptCheckoutCommit', true);
							}
							checkoutCommit();
						}, target);
					}
				}
			}, {
				title: t('Cherry Pick') + ELLIPSIS,
				visible: visibility.cherrypick,
				onClick: () => {
					const isMerge = commit.parents.length > 1;
					let inputs: DialogInput[] = [];
					if (isMerge) {
						let options = commit.parents.map((hash, index) => ({
							name: abbrevCommit(hash) + (typeof this.commitLookup[hash] === 'number' ? ': ' + this.commits[this.commitLookup[hash]].message : ''),
							value: (index + 1).toString()
						}));
						inputs.push({
							type: DialogInputType.Select,
							name: t('Parent Hash'),
							options: options,
							default: '1',
							info: t('Choose the parent hash on the main branch, to cherry pick the commit relative to.')
						});
					}
					inputs.push({
						type: DialogInputType.Checkbox,
						name: t('Record Origin'),
						value: this.config.dialogDefaults.cherryPick.recordOrigin,
						info: t('Record that this commit was the origin of the cherry pick by appending a line to the original commit message that states "(cherry picked from commit ...​)".')
					}, {
						type: DialogInputType.Checkbox,
						name: t('No Commit'),
						value: this.config.dialogDefaults.cherryPick.noCommit,
						info: t('Cherry picked changes will be staged but not committed, so that you can select and commit specific parts of this commit.')
					});

					dialog.showForm(t('Are you sure you want to cherry pick commit <b><i>{0}</i></b>?', abbrevCommit(hash)), inputs, t('Yes, cherry pick'), (values) => {
						let parentIndex = isMerge ? parseInt(<string>values.shift()) : 0;
						runAction({
							command: 'cherrypickCommit',
							repo: this.currentRepo,
							commitHash: hash,
							parentIndex: parentIndex,
							recordOrigin: <boolean>values[0],
							noCommit: <boolean>values[1]
						}, t('Cherry picking Commit'));
					}, target);
				}
			}, {
				title: t('Revert') + ELLIPSIS,
				visible: visibility.revert,
				onClick: () => {
					if (commit.parents.length > 1) {
						let options = commit.parents.map((hash, index) => ({
							name: abbrevCommit(hash) + (typeof this.commitLookup[hash] === 'number' ? ': ' + this.commits[this.commitLookup[hash]].message : ''),
							value: (index + 1).toString()
						}));
						dialog.showSelect(t('Are you sure you want to revert merge commit <b><i>{0}</i></b>? Choose the parent hash on the main branch, to revert the commit relative to:', abbrevCommit(hash)), '1', options, t('Yes, revert'), (parentIndex) => {
							runAction({ command: 'revertCommit', repo: this.currentRepo, commitHash: hash, parentIndex: parseInt(parentIndex) }, t('Reverting Commit'));
						}, target);
					} else {
						dialog.showConfirmation(t('Are you sure you want to revert commit <b><i>{0}</i></b>?', abbrevCommit(hash)), t('Yes, revert'), () => {
							runAction({ command: 'revertCommit', repo: this.currentRepo, commitHash: hash, parentIndex: 0 }, t('Reverting Commit'));
						}, target);
					}
				}
			}, {
				title: t('Drop') + ELLIPSIS,
				visible: visibility.drop && this.graph.dropCommitPossible(this.commitLookup[hash]),
				onClick: () => {
					dialog.showConfirmation(t('Are you sure you want to permanently drop commit <b><i>{0}</i></b>?{1}', abbrevCommit(hash), (this.onlyFollowFirstParent ? t('<br/><i>Note: By enabling "Only follow the first parent of commits", some commits may have been hidden from the Git Map View that could affect the outcome of performing this action.</i>') : '')), t('Yes, drop'), () => {
						runAction({ command: 'dropCommit', repo: this.currentRepo, commitHash: hash }, t('Dropping Commit'));
					}, target);
				}
			}
		], [
			{
				title: t('Merge into current branch') + ELLIPSIS,
				visible: visibility.merge,
				onClick: () => this.mergeAction(hash, abbrevCommit(hash), GG.MergeActionOn.Commit, target)
			}, {
				title: t('Rebase current branch on this Commit') + ELLIPSIS,
				visible: visibility.rebase,
				onClick: () => this.rebaseAction(hash, abbrevCommit(hash), GG.RebaseActionOn.Commit, target)
			}, {
				title: t('Reset current branch to this Commit') + ELLIPSIS,
				visible: visibility.reset,
				onClick: () => {
					dialog.showSelect(t('Are you sure you want to reset {0} to commit <b><i>{1}</i></b>?', (this.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.gitBranchHead)) : t('the current branch')), abbrevCommit(hash)), this.config.dialogDefaults.resetCommit.mode, [
						{ name: t('Soft - Keep all changes, but reset head'), value: GG.GitResetMode.Soft },
						{ name: t('Mixed - Keep working tree, but reset index'), value: GG.GitResetMode.Mixed },
						{ name: t('Hard - Discard all changes'), value: GG.GitResetMode.Hard }
					], t('Yes, reset'), (mode) => {
						runAction({ command: 'resetToCommit', repo: this.currentRepo, commit: hash, resetMode: <GG.GitResetMode>mode }, t('Resetting to Commit'));
					}, target);
				}
			}
		], [
			{
				title: t('Copy Commit Hash to Clipboard'),
				visible: visibility.copyHash,
				shortcut: (/Mac/.test(navigator.platform) ? '\u2318' : 'Ctrl+') + 'C',
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Commit Hash'), data: hash });
				}
			},
			{
				title: t('Copy Commit Subject to Clipboard'),
				visible: visibility.copySubject,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Commit Subject'), data: commit.message });
				}
			}
		]];
	}

	private getRemoteBranchContextMenuActions(remote: string, target: DialogTarget & RefTarget): ContextMenuActions {
		const refName = target.ref, visibility = this.config.contextMenuActionsVisibility.remoteBranch;
		const branchName = remote !== '' ? refName.substring(remote.length + 1) : '';
		const prefixedRefName = 'remotes/' + refName;
		const isSelectedInBranchesDropdown = this.branchDropdown.isSelected(prefixedRefName);
		return [[
			{
				title: t('Checkout Branch') + ELLIPSIS,
				visible: visibility.checkout,
				onClick: () => this.checkoutBranchAction(refName, remote, null, target)
			}, {
				title: t('Delete Remote Branch') + ELLIPSIS,
				visible: visibility.delete && remote !== '',
				onClick: () => {
					dialog.showConfirmation(t('Are you sure you want to delete the remote branch <b><i>{0}</i></b>?', escapeHtml(refName)), t('Yes, delete'), () => {
						runAction({ command: 'deleteRemoteBranch', repo: this.currentRepo, branchName: branchName, remote: remote }, t('Deleting Remote Branch'));
					}, target);
				}
			}, {
				title: t('Fetch into local branch') + ELLIPSIS,
				visible: visibility.fetch && remote !== '' && this.gitBranches.includes(branchName) && this.gitBranchHead !== branchName,
				onClick: () => {
					dialog.showForm(t('Are you sure you want to fetch the remote branch <b><i>{0}</i></b> into the local branch <b><i>{1}</i></b>?', escapeHtml(refName), escapeHtml(branchName)), [{
						type: DialogInputType.Checkbox,
						name: t('Force Fetch'),
						value: this.config.dialogDefaults.fetchIntoLocalBranch.forceFetch,
						info: t('Force the local branch to be reset to this remote branch.')
					}], t('Yes, fetch'), (values) => {
						runAction({ command: 'fetchIntoLocalBranch', repo: this.currentRepo, remote: remote, remoteBranch: branchName, localBranch: branchName, force: <boolean>values[0] }, t('Fetching Branch'));
					}, target);
				}
			}, {
				title: t('Merge into current branch') + ELLIPSIS,
				visible: visibility.merge,
				onClick: () => this.mergeAction(refName, refName, GG.MergeActionOn.RemoteTrackingBranch, target)
			}, {
				title: t('Pull into current branch') + ELLIPSIS,
				visible: visibility.pull && remote !== '',
				onClick: () => this.pullBranchAction(refName, remote, branchName, target)
			}
		], [
			this.getViewIssueAction(refName, visibility.viewIssue, target),
			{
				title: t('Create Pull Request'),
				visible: visibility.createPullRequest && this.gitRepos[this.currentRepo].pullRequestConfig !== null && branchName !== 'HEAD' &&
					(this.gitRepos[this.currentRepo].pullRequestConfig!.sourceRemote === remote || this.gitRepos[this.currentRepo].pullRequestConfig!.destRemote === remote),
				onClick: () => {
					const config = this.gitRepos[this.currentRepo].pullRequestConfig;
					if (config === null) return;
					const isDestRemote = config.destRemote === remote;
					runAction({
						command: 'createPullRequest',
						repo: this.currentRepo,
						config: config,
						sourceRemote: isDestRemote ? config.destRemote! : config.sourceRemote,
						sourceOwner: isDestRemote ? config.destOwner : config.sourceOwner,
						sourceRepo: isDestRemote ? config.destRepo : config.sourceRepo,
						sourceBranch: branchName,
						push: false
					}, t('Creating Pull Request'));
				}
			}
		], [
			{
				title: t('Create Archive'),
				visible: visibility.createArchive,
				onClick: () => {
					runAction({ command: 'createArchive', repo: this.currentRepo, ref: refName }, t('Creating Archive'));
				}
			},
			{
				title: t('Select in Branches Dropdown'),
				visible: visibility.selectInBranchesDropdown && !isSelectedInBranchesDropdown,
				onClick: () => this.branchDropdown.selectOption(prefixedRefName)
			},
			{
				title: t('Unselect in Branches Dropdown'),
				visible: visibility.unselectInBranchesDropdown && isSelectedInBranchesDropdown,
				onClick: () => this.branchDropdown.unselectOption(prefixedRefName)
			}
		], [
			{
				title: t('Copy Branch Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Branch Name'), data: refName });
				}
			}
		]];
	}

	private getStashContextMenuActions(target: DialogTarget & RefTarget): ContextMenuActions {
		const hash = target.hash, selector = target.ref, visibility = this.config.contextMenuActionsVisibility.stash;
		return [[
			{
				title: t('Apply Stash') + ELLIPSIS,
				visible: visibility.apply,
				onClick: () => this.applyStashAction(selector, target)
			}, {
				title: t('Create Branch from Stash') + ELLIPSIS,
				visible: visibility.createBranch,
				onClick: () => {
					dialog.showRefInput(t('Create a branch from stash <b><i>{0}</i></b> with the name:', escapeHtml(selector.substring(5))), '', t('Create Branch'), (branchName) => {
						runAction({ command: 'branchFromStash', repo: this.currentRepo, selector: selector, branchName: branchName }, t('Creating Branch'));
					}, target);
				}
			}, {
				title: t('Pop Stash') + ELLIPSIS,
				visible: visibility.pop,
				onClick: () => this.popStashAction(selector, target)
			}, {
				title: t('Drop Stash') + ELLIPSIS,
				visible: visibility.drop,
				onClick: () => this.dropStashAction(selector, target)
			}
		], [
			{
				title: t('Copy Stash Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Stash Name'), data: selector });
				}
			}, {
				title: t('Copy Stash Hash to Clipboard'),
				visible: visibility.copyHash,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Stash Hash'), data: hash });
				}
			}
		]];
	}

	private getTagContextMenuActions(isAnnotated: boolean, target: DialogTarget & RefTarget): ContextMenuActions {
		const hash = target.hash, tagName = target.ref, visibility = this.config.contextMenuActionsVisibility.tag;
		return [[
			{
				title: t('View Details'),
				visible: visibility.viewDetails && isAnnotated,
				onClick: () => {
					runAction({ command: 'tagDetails', repo: this.currentRepo, tagName: tagName, commitHash: hash }, t('Retrieving Tag Details'));
				}
			}, {
				title: t('Delete Tag') + ELLIPSIS,
				visible: visibility.delete,
				onClick: () => {
					let message = t('Are you sure you want to delete the tag <b><i>{0}</i></b>?', escapeHtml(tagName));
					if (this.gitRemotes.length > 1) {
						let options = [{ name: t('Don\'t delete on any remote'), value: '-1' }];
						this.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
						dialog.showSelect(message + t('<br>Do you also want to delete the tag on a remote:'), '-1', options, t('Yes, delete'), remoteIndex => {
							this.deleteTagAction(tagName, remoteIndex !== '-1' ? this.gitRemotes[parseInt(remoteIndex)] : null);
						}, target);
					} else if (this.gitRemotes.length === 1) {
						dialog.showCheckbox(message, t('Also delete on remote'), false, t('Yes, delete'), deleteOnRemote => {
							this.deleteTagAction(tagName, deleteOnRemote ? this.gitRemotes[0] : null);
						}, target);
					} else {
						dialog.showConfirmation(message, t('Yes, delete'), () => {
							this.deleteTagAction(tagName, null);
						}, target);
					}
				}
			}, {
				title: t('Push Tag') + ELLIPSIS,
				visible: visibility.push && this.gitRemotes.length > 0,
				onClick: () => {
					const runPushTagAction = (remotes: string[]) => {
						runAction({
							command: 'pushTag',
							repo: this.currentRepo,
							tagName: tagName,
							remotes: remotes,
							commitHash: hash,
							skipRemoteCheck: globalState.pushTagSkipRemoteCheck
						}, t('Pushing Tag'));
					};

					if (this.gitRemotes.length === 1) {
						dialog.showConfirmation(t('Are you sure you want to push the tag <b><i>{0}</i></b> to the remote <b><i>{1}</i></b>?', escapeHtml(tagName), escapeHtml(this.gitRemotes[0])), t('Yes, push'), () => {
							runPushTagAction([this.gitRemotes[0]]);
						}, target);
					} else if (this.gitRemotes.length > 1) {
						const defaults = [this.getPushRemote()];
						const options = this.gitRemotes.map((remote) => ({ name: remote, value: remote }));
						dialog.showMultiSelect(t('Are you sure you want to push the tag <b><i>{0}</i></b>? Select the remote(s) to push the tag to:', escapeHtml(tagName)), defaults, options, t('Yes, push'), (remotes) => {
							runPushTagAction(remotes);
						}, target);
					}
				}
			}
		], [
			{
				title: t('Create Archive'),
				visible: visibility.createArchive,
				onClick: () => {
					runAction({ command: 'createArchive', repo: this.currentRepo, ref: tagName }, t('Creating Archive'));
				}
			},
			{
				title: t('Copy Tag Name to Clipboard'),
				visible: visibility.copyName,
				onClick: () => {
					sendMessage({ command: 'copyToClipboard', type: t('Tag Name'), data: tagName });
				}
			}
		]];
	}

	private getUncommittedChangesContextMenuActions(target: DialogTarget & CommitTarget): ContextMenuActions {
		let visibility = this.config.contextMenuActionsVisibility.uncommittedChanges;
		return [[
			{
				title: t('Stash uncommitted changes') + ELLIPSIS,
				visible: visibility.stash,
				onClick: () => this.stashUncommittedChangesAction(target)
			}
		], [
			{
				title: t('Reset uncommitted changes') + ELLIPSIS,
				visible: visibility.reset,
				onClick: () => {
					dialog.showSelect(t('Are you sure you want to reset the <b>uncommitted changes</b> to <b>HEAD</b>?'), this.config.dialogDefaults.resetUncommitted.mode, [
						{ name: t('Mixed - Keep working tree, but reset index'), value: GG.GitResetMode.Mixed },
						{ name: t('Hard - Discard all changes'), value: GG.GitResetMode.Hard }
					], t('Yes, reset'), (mode) => {
						runAction({ command: 'resetToCommit', repo: this.currentRepo, commit: 'HEAD', resetMode: <GG.GitResetMode>mode }, t('Resetting uncommitted changes'));
					}, target);
				}
			}, {
				title: t('Clean untracked files') + ELLIPSIS,
				visible: visibility.clean,
				onClick: () => {
					dialog.showCheckbox(t('Are you sure you want to clean all untracked files?'), t('Clean untracked directories'), true, t('Yes, clean'), directories => {
						runAction({ command: 'cleanUntrackedFiles', repo: this.currentRepo, directories: directories }, t('Cleaning untracked files'));
					}, target);
				}
			}
		], [
			{
				title: t('Open Source Control View'),
				visible: visibility.openSourceControlView,
				onClick: () => {
					sendMessage({ command: 'viewScm' });
				}
			}
		]];
	}

	private getViewIssueAction(refName: string, visible: boolean, target: DialogTarget & RefTarget): ContextMenuAction {
		const issueLinks: { url: string, displayText: string }[] = [];

		let issueLinking: IssueLinking | null, match: RegExpExecArray | null;
		if (visible && (issueLinking = parseIssueLinkingConfig(this.gitRepos[this.currentRepo].issueLinkingConfig)) !== null) {
			issueLinking.regexp.lastIndex = 0;
			while (match = issueLinking.regexp.exec(refName)) {
				if (match[0].length === 0) break;
				issueLinks.push({
					url: generateIssueLinkFromMatch(match, issueLinking),
					displayText: match[0]
				});
			}
		}

		return {
			title: t('View Issue{0}', (issueLinks.length > 1 ? ELLIPSIS : '')),
			visible: issueLinks.length > 0,
			onClick: () => {
				if (issueLinks.length > 1) {
					dialog.showSelect(t('Select which issue you want to view for this branch:'), '0', issueLinks.map((issueLink, i) => ({ name: issueLink.displayText, value: i.toString() })), t('View Issue'), (value) => {
						sendMessage({ command: 'openExternalUrl', url: issueLinks[parseInt(value)].url });
					}, target);
				} else if (issueLinks.length === 1) {
					sendMessage({ command: 'openExternalUrl', url: issueLinks[0].url });
				}
			}
		};
	}


	/* Actions */

	private addTagAction(hash: string, initialName: string, initialType: GG.TagType, initialMessage: string, initialPushToRemote: string | null, target: DialogTarget & CommitTarget, isInitialLoad: boolean = true) {
		let mostRecentTagsIndex = -1;
		for (let i = 0; i < this.commits.length; i++) {
			if (this.commits[i].tags.length > 0 && (mostRecentTagsIndex === -1 || this.commits[i].date > this.commits[mostRecentTagsIndex].date)) {
				mostRecentTagsIndex = i;
			}
		}
		const mostRecentTags = mostRecentTagsIndex > -1 ? this.commits[mostRecentTagsIndex].tags.map((tag) => '"' + tag.name + '"') : [];

		const inputs: DialogInput[] = [
			{ type: DialogInputType.TextRef, name: t('Name'), default: initialName, info: mostRecentTags.length > 0 ? t('The most recent tag{0} in the loaded commits {1} {2}.', (mostRecentTags.length > 1 ? 's' : ''), (mostRecentTags.length > 1 ? 'are' : 'is'), formatCommaSeparatedList(mostRecentTags)) : undefined },
			{ type: DialogInputType.Select, name: t('Type'), default: initialType === GG.TagType.Annotated ? 'annotated' : 'lightweight', options: [{ name: t('Annotated'), value: 'annotated' }, { name: t('Lightweight'), value: 'lightweight' }] },
			{ type: DialogInputType.Text, name: t('Message'), default: initialMessage, placeholder: t('Optional'), info: t('A message can only be added to an annotated tag.') }
		];
		if (this.gitRemotes.length > 1) {
			const options = [{ name: t('Don\'t push'), value: '-1' }];
			this.gitRemotes.forEach((remote, i) => options.push({ name: remote, value: i.toString() }));
			const defaultOption = initialPushToRemote !== null
				? this.gitRemotes.indexOf(initialPushToRemote)
				: isInitialLoad && this.config.dialogDefaults.addTag.pushToRemote
					? this.gitRemotes.indexOf(this.getPushRemote())
					: -1;
			inputs.push({ type: DialogInputType.Select, name: t('Push to remote'), options: options, default: defaultOption.toString(), info: t('Once this tag has been added, push it to this remote.') });
		} else if (this.gitRemotes.length === 1) {
			const defaultValue = initialPushToRemote !== null || (isInitialLoad && this.config.dialogDefaults.addTag.pushToRemote);
			inputs.push({ type: DialogInputType.Checkbox, name: t('Push to remote'), value: defaultValue, info: t('Once this tag has been added, push it to the repositories remote.') });
		}

		dialog.showForm(t('Add tag to commit <b><i>{0}</i></b>:', abbrevCommit(hash)), inputs, t('Add Tag'), (values) => {
			const tagName = <string>values[0];
			const type = <string>values[1] === 'annotated' ? GG.TagType.Annotated : GG.TagType.Lightweight;
			const message = <string>values[2];
			const pushToRemote = this.gitRemotes.length > 1 && <string>values[3] !== '-1'
				? this.gitRemotes[parseInt(<string>values[3])]
				: this.gitRemotes.length === 1 && <boolean>values[3]
					? this.gitRemotes[0]
					: null;

			const runAddTagAction = (force: boolean) => {
				runAction({
					command: 'addTag',
					repo: this.currentRepo,
					tagName: tagName,
					commitHash: hash,
					type: type,
					message: message,
					pushToRemote: pushToRemote,
					pushSkipRemoteCheck: globalState.pushTagSkipRemoteCheck,
					force: force
				}, t('Adding Tag'));
			};

			if (this.gitTags.includes(tagName)) {
				dialog.showTwoButtons(t('A tag named <b><i>{0}</i></b> already exists, do you want to replace it with this new tag?', escapeHtml(tagName)), t('Yes, replace the existing tag'), () => {
					runAddTagAction(true);
				}, t('No, choose another tag name'), () => {
					this.addTagAction(hash, tagName, type, message, pushToRemote, target, false);
				}, target);
			} else {
				runAddTagAction(false);
			}
		}, target);
	}

	private checkoutBranchAction(refName: string, remote: string | null, prefillName: string | null, target: DialogTarget & (CommitTarget | RefTarget)) {
		if (remote !== null) {
			dialog.showRefInput(t('Enter the name of the new branch you would like to create when checking out <b><i>{0}</i></b>:', escapeHtml(refName)), (prefillName !== null ? prefillName : (remote !== '' ? refName.substring(remote.length + 1) : refName)), t('Checkout Branch'), newBranch => {
				if (this.gitBranches.includes(newBranch)) {
					const canPullFromRemote = remote !== '';
					dialog.showTwoButtons(t('The name <b><i>{0}</i></b> is already used by another branch:', escapeHtml(newBranch)), t('Choose another branch name'), () => {
						this.checkoutBranchAction(refName, remote, newBranch, target);
					}, t('Checkout the existing branch{0}', (canPullFromRemote ? t(' & pull changes') : '')), () => {
						runAction({
							command: 'checkoutBranch',
							repo: this.currentRepo,
							branchName: newBranch,
							remoteBranch: null,
							pullAfterwards: canPullFromRemote
								? {
									branchName: refName.substring(remote.length + 1),
									remote: remote,
									createNewCommit: this.config.dialogDefaults.pullBranch.noFastForward,
									squash: this.config.dialogDefaults.pullBranch.squash
								}
								: null
						}, t('Checking out Branch{0}', (canPullFromRemote ? t(' & Pulling Changes') : '')));
					}, target);
				} else {
					runAction({ command: 'checkoutBranch', repo: this.currentRepo, branchName: newBranch, remoteBranch: refName, pullAfterwards: null }, t('Checking out Branch'));
				}
			}, target);
		} else {
			runAction({ command: 'checkoutBranch', repo: this.currentRepo, branchName: refName, remoteBranch: null, pullAfterwards: null }, t('Checking out Branch'));
		}
	}

	private createBranchAction(hash: string, initialName: string, initialCheckOut: boolean, target: DialogTarget & CommitTarget) {
		dialog.showForm(t('Create branch at commit <b><i>{0}</i></b>:', abbrevCommit(hash)), [
			{ type: DialogInputType.TextRef, name: t('Name'), default: initialName },
			{ type: DialogInputType.Checkbox, name: t('Check out'), value: initialCheckOut }
		], t('Create Branch'), (values) => {
			const branchName = <string>values[0], checkOut = <boolean>values[1];
			if (this.gitBranches.includes(branchName)) {
				dialog.showTwoButtons(t('A branch named <b><i>{0}</i></b> already exists, do you want to replace it with this new branch?', escapeHtml(branchName)), t('Yes, replace the existing branch'), () => {
					runAction({ command: 'createBranch', repo: this.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: true }, t('Creating Branch'));
				}, t('No, choose another branch name'), () => {
					this.createBranchAction(hash, branchName, checkOut, target);
				}, target);
			} else {
				runAction({ command: 'createBranch', repo: this.currentRepo, branchName: branchName, commitHash: hash, checkout: checkOut, force: false }, t('Creating Branch'));
			}
		}, target);
	}

	private deleteTagAction(refName: string, deleteOnRemote: string | null) {
		runAction({ command: 'deleteTag', repo: this.currentRepo, tagName: refName, deleteOnRemote: deleteOnRemote }, t('Deleting Tag'));
	}

	/**
	 * Show the dialog to push a branch to the remote(s).
	 * @param refName The name of the branch.
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	private pushBranchAction(refName: string, target: DialogTarget | null) {
		const multipleRemotes = this.gitRemotes.length > 1;
		const inputs: DialogInput[] = [
			{ type: DialogInputType.Checkbox, name: t('Set Upstream'), value: true },
			{
				type: DialogInputType.Radio,
				name: t('Push Mode'),
				options: [
					{ name: t('Normal'), value: GG.GitPushBranchMode.Normal },
					{ name: t('Force With Lease'), value: GG.GitPushBranchMode.ForceWithLease },
					{ name: t('Force'), value: GG.GitPushBranchMode.Force }
				],
				default: GG.GitPushBranchMode.Normal
			}
		];

		if (multipleRemotes) {
			inputs.unshift({
				type: DialogInputType.Select,
				name: t('Push to Remote(s)'),
				defaults: [this.getPushRemote(refName)],
				options: this.gitRemotes.map((remote) => ({ name: remote, value: remote })),
				multiple: true
			});
		}

		dialog.showForm(t('Are you sure you want to push the branch <b><i>{0}</i></b>{1}?', escapeHtml(refName), (multipleRemotes ? '' : t(' to the remote <b><i>{0}</i></b>', escapeHtml(this.gitRemotes[0])))), inputs, t('Yes, push'), (values) => {
			const remotes = multipleRemotes ? <string[]>values.shift() : [this.gitRemotes[0]];
			const setUpstream = <boolean>values[0];
			runAction({
				command: 'pushBranch',
				repo: this.currentRepo,
				branchName: refName,
				remotes: remotes,
				setUpstream: setUpstream,
				mode: <GG.GitPushBranchMode>values[1],
				willUpdateBranchConfig: setUpstream && remotes.length > 0 && (this.gitConfig === null || typeof this.gitConfig.branches[refName] === 'undefined' || this.gitConfig.branches[refName].remote !== remotes[remotes.length - 1])
			}, t('Pushing Branch'));
		}, target);
	}

	/**
	 * Show the dialog to pull a remote branch into the current branch.
	 * @param refName The name of the remote branch (including the name of the remote).
	 * @param remote The name of the remote.
	 * @param branchName The name of the branch on the remote.
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	private pullBranchAction(refName: string, remote: string, branchName: string, target: DialogTarget | null) {
		dialog.showForm(t('Are you sure you want to pull the remote branch <b><i>{0}</i></b> into {1}? If a merge is required:', escapeHtml(refName), (this.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.gitBranchHead)) : t('the current branch'))), [
			{ type: DialogInputType.Checkbox, name: t('Create a new commit even if fast-forward is possible'), value: this.config.dialogDefaults.pullBranch.noFastForward },
			{ type: DialogInputType.Checkbox, name: t('Squash Commits'), value: this.config.dialogDefaults.pullBranch.squash, info: t('Create a single commit on the current branch whose effect is the same as merging this remote branch.') }
		], t('Yes, pull'), (values) => {
			runAction({ command: 'pullBranch', repo: this.currentRepo, branchName: branchName, remote: remote, createNewCommit: <boolean>values[0], squash: <boolean>values[1] }, t('Pulling Branch'));
		}, target);
	}

	/**
	 * Show the dialog to apply a stash.
	 * @param selector The selector of the stash (e.g. "refs/stash@{0}").
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	private applyStashAction(selector: string, target: DialogTarget | null) {
		dialog.showForm(t('Are you sure you want to apply the stash <b><i>{0}</i></b>?', escapeHtml(selector.substring(5))), [{
			type: DialogInputType.Checkbox,
			name: t('Reinstate Index'),
			value: this.config.dialogDefaults.applyStash.reinstateIndex,
			info: t('Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.')
		}], t('Yes, apply stash'), (values) => {
			runAction({ command: 'applyStash', repo: this.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, t('Applying Stash'));
		}, target);
	}

	/**
	 * Show the dialog to pop a stash.
	 * @param selector The selector of the stash (e.g. "refs/stash@{0}").
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	private popStashAction(selector: string, target: DialogTarget | null) {
		dialog.showForm(t('Are you sure you want to pop the stash <b><i>{0}</i></b>?', escapeHtml(selector.substring(5))), [{
			type: DialogInputType.Checkbox,
			name: t('Reinstate Index'),
			value: this.config.dialogDefaults.popStash.reinstateIndex,
			info: t('Attempt to reinstate the indexed changes, in addition to the working tree\'s changes.')
		}], t('Yes, pop stash'), (values) => {
			runAction({ command: 'popStash', repo: this.currentRepo, selector: selector, reinstateIndex: <boolean>values[0] }, t('Popping Stash'));
		}, target);
	}

	/**
	 * Show the dialog to drop a stash.
	 * @param selector The selector of the stash (e.g. "refs/stash@{0}").
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	private dropStashAction(selector: string, target: DialogTarget | null) {
		dialog.showConfirmation(t('Are you sure you want to drop the stash <b><i>{0}</i></b>?', escapeHtml(selector.substring(5))), t('Yes, drop'), () => {
			runAction({ command: 'dropStash', repo: this.currentRepo, selector: selector }, t('Dropping Stash'));
		}, target);
	}

	/**
	 * Show the dialog to stash the uncommitted changes.
	 * @param target The target of the dialog (NULL if the dialog isn't for an element in the view).
	 */
	private stashUncommittedChangesAction(target: DialogTarget | null) {
		dialog.showForm(t('Are you sure you want to stash the <b>uncommitted changes</b>?'), [
			{ type: DialogInputType.Text, name: t('Message'), default: '', placeholder: t('Optional') },
			{ type: DialogInputType.Checkbox, name: t('Include Untracked'), value: this.config.dialogDefaults.stashUncommittedChanges.includeUntracked, info: t('Include all untracked files in the stash, and then clean them from the working directory.') }
		], t('Yes, stash'), (values) => {
			runAction({ command: 'pushStash', repo: this.currentRepo, message: <string>values[0], includeUntracked: <boolean>values[1] }, t('Stashing uncommitted changes'));
		}, target);
	}

	private fetchFromRemotesAction() {
		runAction({ command: 'fetch', repo: this.currentRepo, name: null, prune: this.config.fetchAndPrune, pruneTags: this.config.fetchAndPruneTags }, t('Fetching from Remote(s)'));
	}

	private mergeAction(obj: string, name: string, actionOn: GG.MergeActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {
		dialog.showForm(t('Are you sure you want to merge {0} <b><i>{1}</i></b> into {2}?', t(actionOn).toLowerCase(), escapeHtml(name), (this.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.gitBranchHead)) : t('the current branch'))), [
			{ type: DialogInputType.Checkbox, name: t('Create a new commit even if fast-forward is possible'), value: this.config.dialogDefaults.merge.noFastForward },
			{ type: DialogInputType.Checkbox, name: t('Squash Commits'), value: this.config.dialogDefaults.merge.squash, info: t('Create a single commit on the current branch whose effect is the same as merging this {0}.', t(actionOn).toLowerCase()) },
			{ type: DialogInputType.Checkbox, name: t('No Commit'), value: this.config.dialogDefaults.merge.noCommit, info: t('The changes of the merge will be staged but not committed, so that you can review and/or modify the merge result before committing.') }
		], t('Yes, merge'), (values) => {
			runAction({ command: 'merge', repo: this.currentRepo, obj: obj, actionOn: actionOn, createNewCommit: <boolean>values[0], squash: <boolean>values[1], noCommit: <boolean>values[2] }, t('Merging {0}', t(actionOn)));
		}, target);
	}

	private rebaseAction(obj: string, name: string, actionOn: GG.RebaseActionOn, target: DialogTarget & (CommitTarget | RefTarget)) {
		dialog.showForm(t('Are you sure you want to rebase {0} on {1} <b><i>{2}</i></b>?', (this.gitBranchHead !== null ? t('<b><i>{0}</i></b> (the current branch)', escapeHtml(this.gitBranchHead)) : t('the current branch')), actionOn.toLowerCase(), escapeHtml(name)), [
			{ type: DialogInputType.Checkbox, name: t('Launch Interactive Rebase in new Terminal'), value: this.config.dialogDefaults.rebase.interactive },
			{ type: DialogInputType.Checkbox, name: t('Ignore Date'), value: this.config.dialogDefaults.rebase.ignoreDate, info: t('Only applicable to a non-interactive rebase.') }
		], t('Yes, rebase'), (values) => {
			let interactive = <boolean>values[0];
			runAction({ command: 'rebase', repo: this.currentRepo, obj: obj, actionOn: actionOn, ignoreDate: <boolean>values[1], interactive: interactive }, interactive ? t('Launching Interactive Rebase') : t('Rebasing on {0}', t(actionOn)));
		}, target);
	}


	/* Table Utils */

	private makeTableResizable() {
		let colHeadersElem = document.getElementById('tableColHeaders')!, cols = <HTMLCollectionOf<HTMLElement>>document.getElementsByClassName('tableColHeader');
		let columnWidths: GG.ColumnWidth[], mouseX = -1, col = -1, colIndex = -1;

		const makeTableFixedLayout = () => {
			cols[0].style.width = columnWidths[0] + 'px';
			cols[0].style.padding = '';
			for (let i = 2; i < cols.length; i++) {
				cols[i].style.width = columnWidths[parseInt(cols[i].dataset.col!)] + 'px';
			}
			this.tableElem.className = 'fixedLayout';
			this.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
			this.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
		};

		for (let i = 0; i < cols.length; i++) {
			let col = parseInt(cols[i].dataset.col!);
			cols[i].innerHTML += (i > 0 ? '<span class="resizeCol left" data-col="' + (col - 1) + '"></span>' : '') + (i < cols.length - 1 ? '<span class="resizeCol right" data-col="' + col + '"></span>' : '');
		}

		let cWidths = this.gitRepos[this.currentRepo].columnWidths;
		if (cWidths === null) { // Initialise auto column layout if it is the first time viewing the repo.
			let defaults = this.config.defaultColumnVisibility;
			columnWidths = [COLUMN_AUTO, COLUMN_AUTO, defaults.date ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.author ? COLUMN_AUTO : COLUMN_HIDDEN, defaults.commit ? COLUMN_AUTO : COLUMN_HIDDEN];
			this.saveColumnWidths(columnWidths);
		} else {
			columnWidths = [cWidths[0], COLUMN_AUTO, cWidths[1], cWidths[2], cWidths[3]];
		}

		if (columnWidths[0] !== COLUMN_AUTO) {
			// Table should have fixed layout
			makeTableFixedLayout();
		} else {
			// Table should have automatic layout
			this.tableElem.className = 'autoLayout';

			let colWidth = cols[0].offsetWidth, graphWidth = this.graph.getNaturalContentWidth();
			let maxWidth = Math.round(this.viewElem.clientWidth * 0.333);
			if (Math.max(graphWidth, colWidth) > maxWidth) {
				this.graph.limitMaxWidth(maxWidth);
				graphWidth = Math.min(this.graph.getContentWidth(), maxWidth);
				this.tableElem.className += ' limitGraphWidth';
				this.tableElem.style.setProperty(CSS_PROP_LIMIT_GRAPH_WIDTH, maxWidth + 'px');
			} else {
				this.graph.limitMaxWidth(-1);
				this.tableElem.style.removeProperty(CSS_PROP_LIMIT_GRAPH_WIDTH);
			}

			if (colWidth < Math.max(graphWidth, 64)) {
				cols[0].style.padding = '6px ' + Math.floor((Math.max(graphWidth, 64) - (colWidth - COLUMN_LEFT_RIGHT_PADDING)) / 2) + 'px';
			}
		}

		const processResizingColumn: EventListener = (e) => {
			if (col > -1) {
				let mouseEvent = <MouseEvent>e;
				let mouseDeltaX = mouseEvent.clientX - mouseX;

				if (col === 0) {
					if (columnWidths[0] + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -columnWidths[0] + COLUMN_MIN_WIDTH;
					if (cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING - COLUMN_MIN_WIDTH;
					columnWidths[0] += mouseDeltaX;
					cols[0].style.width = columnWidths[0] + 'px';
					this.graph.limitMaxWidth(columnWidths[0] + COLUMN_LEFT_RIGHT_PADDING);
				} else {
					let colWidth = col !== 1 ? columnWidths[col] : cols[1].clientWidth - COLUMN_LEFT_RIGHT_PADDING;
					let nextCol = col + 1;
					while (columnWidths[nextCol] === COLUMN_HIDDEN) nextCol++;

					if (colWidth + mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = -colWidth + COLUMN_MIN_WIDTH;
					if (columnWidths[nextCol] - mouseDeltaX < COLUMN_MIN_WIDTH) mouseDeltaX = columnWidths[nextCol] - COLUMN_MIN_WIDTH;
					if (col !== 1) {
						columnWidths[col] += mouseDeltaX;
						cols[colIndex].style.width = columnWidths[col] + 'px';
					}
					columnWidths[nextCol] -= mouseDeltaX;
					cols[colIndex + 1].style.width = columnWidths[nextCol] + 'px';
				}
				mouseX = mouseEvent.clientX;
			}
		};
		const stopResizingColumn: EventListener = () => {
			if (col > -1) {
				col = -1;
				colIndex = -1;
				mouseX = -1;
				eventOverlay.remove();
				this.saveColumnWidths(columnWidths);
			}
		};

		addListenerToClass('resizeCol', 'mousedown', (e) => {
			if (e.target === null) return;
			col = parseInt((<HTMLElement>e.target).dataset.col!);
			while (columnWidths[col] === COLUMN_HIDDEN) col--;
			mouseX = (<MouseEvent>e).clientX;

			let isAuto = columnWidths[0] === COLUMN_AUTO;
			for (let i = 0; i < cols.length; i++) {
				let curCol = parseInt(cols[i].dataset.col!);
				if (isAuto && curCol !== 1) columnWidths[curCol] = cols[i].clientWidth - COLUMN_LEFT_RIGHT_PADDING;
				if (curCol === col) colIndex = i;
			}
			if (isAuto) makeTableFixedLayout();
			eventOverlay.create('colResize', processResizingColumn, stopResizingColumn);
		});

		colHeadersElem.addEventListener('contextmenu', (e: MouseEvent) => {
			handledEvent(e);

			const toggleColumnState = (col: number, defaultWidth: number) => {
				columnWidths[col] = columnWidths[col] !== COLUMN_HIDDEN ? COLUMN_HIDDEN : columnWidths[0] === COLUMN_AUTO ? COLUMN_AUTO : defaultWidth - COLUMN_LEFT_RIGHT_PADDING;
				this.saveColumnWidths(columnWidths);
				this.render();
			};

			const commitOrdering = getCommitOrdering(this.gitRepos[this.currentRepo].commitOrdering);
			const changeCommitOrdering = (repoCommitOrdering: GG.RepoCommitOrdering) => {
				this.saveRepoStateValue(this.currentRepo, 'commitOrdering', repoCommitOrdering);
				this.refresh(true);
			};

			contextMenu.show([
				[
					{
						title: t('Changes'),
						visible: this.fileHistory === null,
						checked: this.isChangesColumnShown(),
						onClick: () => {
							this.saveRepoStateValue(this.currentRepo, 'showChangesColumn', !this.isChangesColumnShown());
							this.render();
							this.requestCommitStats(false);
						}
					},
					{
						title: t('Date'),
						visible: true,
						checked: columnWidths[2] !== COLUMN_HIDDEN,
						onClick: () => toggleColumnState(2, 128)
					},
					{
						title: t('Author'),
						visible: true,
						checked: columnWidths[3] !== COLUMN_HIDDEN,
						onClick: () => toggleColumnState(3, 128)
					},
					{
						title: t('Commit'),
						visible: true,
						checked: columnWidths[4] !== COLUMN_HIDDEN,
						onClick: () => toggleColumnState(4, 80)
					}
				],
				[
					{
						title: t('Commit Timestamp Order'),
						visible: true,
						checked: commitOrdering === GG.CommitOrdering.Date,
						onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Date)
					},
					{
						title: t('Author Timestamp Order'),
						visible: true,
						checked: commitOrdering === GG.CommitOrdering.AuthorDate,
						onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.AuthorDate)
					},
					{
						title: t('Topological Order'),
						visible: true,
						checked: commitOrdering === GG.CommitOrdering.Topological,
						onClick: () => changeCommitOrdering(GG.RepoCommitOrdering.Topological)
					}
				]
			], true, null, e, this.viewElem);
		});
	}

	public getColumnVisibility() {
		let colWidths = this.gitRepos[this.currentRepo].columnWidths;
		if (colWidths !== null) {
			return { date: colWidths[1] !== COLUMN_HIDDEN, author: colWidths[2] !== COLUMN_HIDDEN, commit: colWidths[3] !== COLUMN_HIDDEN };
		} else {
			let defaults = this.config.defaultColumnVisibility;
			return { date: defaults.date, author: defaults.author, commit: defaults.commit };
		}
	}

	private getNumColumns() {
		let colVisibility = this.getColumnVisibility();
		return 2 + (this.config.referenceLabels.inSeparateColumn ? 1 : 0) + (this.fileHistory !== null || this.isChangesColumnShown() ? 1 : 0) + (colVisibility.date ? 1 : 0) + (colVisibility.author ? 1 : 0) + (colVisibility.commit ? 1 : 0);
	}

	/**
	 * Scroll the view to the previous or next stash.
	 * @param next TRUE => Jump to the next stash, FALSE => Jump to the previous stash.
	 */
	private scrollToStash(next: boolean) {
		const stashCommits = this.commits.filter((commit) => commit.stash !== null);
		if (stashCommits.length > 0) {
			const curTime = (new Date()).getTime();
			if (this.lastScrollToStash.time < curTime - 5000) {
				// Reset the lastScrollToStash hash if it was more than 5 seconds ago
				this.lastScrollToStash.hash = null;
			}

			const lastScrollToStashCommitIndex = this.lastScrollToStash.hash !== null
				? stashCommits.findIndex((commit) => commit.hash === this.lastScrollToStash.hash)
				: -1;
			let scrollToStashCommitIndex = lastScrollToStashCommitIndex + (next ? 1 : -1);
			if (scrollToStashCommitIndex >= stashCommits.length) {
				scrollToStashCommitIndex = 0;
			} else if (scrollToStashCommitIndex < 0) {
				scrollToStashCommitIndex = stashCommits.length - 1;
			}
			this.scrollToCommit(stashCommits[scrollToStashCommitIndex].hash, true, true);
			this.lastScrollToStash.time = curTime;
			this.lastScrollToStash.hash = stashCommits[scrollToStashCommitIndex].hash;
		}
	}

	/**
	 * Scroll the view to a commit (if it exists).
	 * @param hash The hash of the commit to scroll to.
	 * @param alwaysCenterCommit TRUE => Always scroll the view to be centered on the commit. FALSE => Don't scroll the view if the commit is already within the visible portion of commits.
	 * @param flash Should the commit flash after it has been scrolled to.
	 */
	public scrollToCommit(hash: string, alwaysCenterCommit: boolean, flash: boolean = false) {
		const elem = findCommitElemWithId(getCommitElems(), this.getCommitId(hash));
		if (elem === null) return;

		// The controls are sticky (always visible at the top of the view), so commits are only visible below them
		const headerHeight = this.controlsElem.clientHeight, elemTop = headerHeight + elem.offsetTop;
		if (alwaysCenterCommit || elemTop - 8 < this.viewElem.scrollTop + headerHeight || elemTop + 32 - this.viewElem.clientHeight > this.viewElem.scrollTop) {
			this.viewElem.scroll(0, elemTop + 12 - (this.viewElem.clientHeight + headerHeight) / 2);
		}

		if (flash && !elem.classList.contains('flash')) {
			elem.classList.add('flash');
			setTimeout(() => {
				elem.classList.remove('flash');
			}, 850);
		}
	}

	/**
	 * Scroll to the commit referenced by HEAD. If it hasn't been loaded yet, more commits are loaded until it is (when the branches being shown include HEAD).
	 */
	private scrollToHead() {
		const headBranchShown = this.currentBranches === null || this.currentBranches.includes(SHOW_ALL_BRANCHES) || (this.gitBranchHead !== null && this.currentBranches.includes(this.gitBranchHead));
		if (this.commitHead !== null && typeof this.commitLookup[this.commitHead] === 'number') {
			this.scrollToHeadPending = false;
			this.scrollToCommit(this.commitHead, true, true);
		} else if (this.commitHead !== null && this.moreCommitsAvailable && headBranchShown) {
			this.scrollToHeadPending = true;
			if (!this.currentRepoRefreshState.inProgress) {
				this.loadMoreCommits();
			}
		} else {
			this.scrollToHeadPending = false;
		}
	}

	private loadMoreCommits() {
		this.footerElem.innerHTML = '<h2 id="loadingHeader">' + SVG_ICONS.loading + t('Loading ...') + '</h2>';
		this.maxCommits += this.config.loadMoreCommits;
		this.saveState();
		this.requestLoadRepoInfoAndCommits(false, true);
	}


	/* Observers */

	private observeWindowSizeChanges() {
		let windowWidth = window.outerWidth, windowHeight = window.outerHeight;
		window.addEventListener('resize', () => {
			const cdvElem = document.getElementById('cdv');
			if (cdvElem !== null && this.isCdvDocked() && this.isCdvDockedRight()) {
				this.setCdvHeight(cdvElem, true);
			}
			if (windowWidth === window.outerWidth && windowHeight === window.outerHeight) {
				this.renderGraph();
			} else {
				windowWidth = window.outerWidth;
				windowHeight = window.outerHeight;
			}
		});
	}

	private observeWebviewStyleChanges() {
		let fontFamily = getVSCodeStyle(CSS_PROP_FONT_FAMILY),
			editorFontFamily = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),
			findMatchColour = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),
			selectionBackgroundColor = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);

		const setFlashColour = (colour: string) => {
			document.body.style.setProperty('--git-graph-flashPrimary', modifyColourOpacity(colour, 0.7));
			document.body.style.setProperty('--git-graph-flashSecondary', modifyColourOpacity(colour, 0.5));
		};
		const setSelectionBackgroundColorExists = () => {
			alterClass(document.body, 'selection-background-color-exists', selectionBackgroundColor);
		};

		this.findWidget.setColour(findMatchColour);
		setFlashColour(findMatchColour);
		setSelectionBackgroundColorExists();

		(new MutationObserver(() => {
			let ff = getVSCodeStyle(CSS_PROP_FONT_FAMILY),
				eff = getVSCodeStyle(CSS_PROP_EDITOR_FONT_FAMILY),
				fmc = getVSCodeStyle(CSS_PROP_FIND_MATCH_HIGHLIGHT_BACKGROUND),
				sbc = !!getVSCodeStyle(CSS_PROP_SELECTION_BACKGROUND);

			if (ff !== fontFamily || eff !== editorFontFamily) {
				fontFamily = ff;
				editorFontFamily = eff;
				this.repoDropdown.refresh();
				this.branchDropdown.refresh();
				this.authorDropdown.refresh();
			}
			if (fmc !== findMatchColour) {
				findMatchColour = fmc;
				this.findWidget.setColour(findMatchColour);
				setFlashColour(findMatchColour);
			}
			if (selectionBackgroundColor !== sbc) {
				selectionBackgroundColor = sbc;
				setSelectionBackgroundColorExists();
			}
		})).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
	}

	private observeViewScroll() {
		let active = this.viewElem.scrollTop > 0, timeout: number | null = null;
		this.scrollShadowElem.className = active ? CLASS_ACTIVE : '';
		this.viewElem.addEventListener('scroll', () => {
			const scrollTop = this.viewElem.scrollTop;
			if (active !== scrollTop > 0) {
				active = scrollTop > 0;
				this.scrollShadowElem.className = active ? CLASS_ACTIVE : '';
			}

			if (this.config.loadMoreCommitsAutomatically && this.moreCommitsAvailable && !this.currentRepoRefreshState.inProgress) {
				const viewHeight = this.viewElem.clientHeight, contentHeight = this.viewElem.scrollHeight;
				if (scrollTop > 0 && viewHeight > 0 && contentHeight > 0 && (scrollTop + viewHeight) >= contentHeight - 25) {
					// If the user has scrolled such that the bottom of the visible view is within 25px of the end of the content, load more commits.
					this.loadMoreCommits();
				}
			}

			if (timeout !== null) clearTimeout(timeout);
			timeout = setTimeout(() => {
				this.scrollTop = scrollTop;
				this.saveState();
				timeout = null;
			}, 250);
		});
	}

	private observeMouseNavigationButtons() {
		// The back / forward buttons of a mouse navigate the Visual Studio Code editor history (the events aren't handled by Visual Studio Code when they occur in a Webview)
		document.addEventListener('mouseup', (e) => {
			if (e.button === 3 || e.button === 4) {
				handledEvent(e);
				sendMessage({ command: 'navigateEditorHistory', forward: e.button === 4 });
			}
		});
	}

	private observeKeyboardEvents() {
		// The time at which a Ctrl / Cmd keybinding that wasn't handled by Git Map was pressed. Visual Studio Code may treat it as the first part of a keybinding chord (e.g. Ctrl+K Ctrl+S), so Git Map doesn't handle the next keypress (which Visual Studio Code is waiting for).
		let possibleChordStart = 0;
		window.addEventListener('blur', () => {
			possibleChordStart = 0;
		});

		document.addEventListener('keydown', (e) => {
			if (e.key === 'Control' || e.key === 'Meta' || e.key === 'Shift' || e.key === 'Alt') return;
			const chordInProgress = possibleChordStart > 0 && Date.now() - possibleChordStart < 1500;
			possibleChordStart = 0;

			if (contextMenu.isOpen()) {
				if (e.key === 'Escape') {
					contextMenu.close();
					handledEvent(e);
				} else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c' && this.copyCommitHashWithKeyboard(e)) {
					// Copy the hash of the commit whose context menu is open (as shown in the context menu)
					handledEvent(e);
				}
			} else if (dialog.isOpen()) {
				if (e.key === 'Escape') {
					dialog.close();
					handledEvent(e);
				} else if (e.keyCode ? e.keyCode === 13 : e.key === 'Enter') {
					// Use keyCode === 13 to detect 'Enter' events if available (for compatibility with IME Keyboards used by Chinese / Japanese / Korean users)
					dialog.submit();
					handledEvent(e);
				}
			} else if (this.expandedCommit !== null && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
				const curHashIndex = this.commitLookup[this.expandedCommit.commitHash];
				let newHashIndex = -1;

				if (e.ctrlKey || e.metaKey) {
					// Up / Down navigates according to the order of commits on the branch
					if (e.shiftKey) {
						// Follow commits on alternative branches when possible
						if (e.key === 'ArrowUp') {
							newHashIndex = this.graph.getAlternativeChildIndex(curHashIndex);
						} else if (e.key === 'ArrowDown') {
							newHashIndex = this.graph.getAlternativeParentIndex(curHashIndex);
						}
					} else {
						// Follow commits on the same branch
						if (e.key === 'ArrowUp') {
							newHashIndex = this.graph.getFirstChildIndex(curHashIndex);
						} else if (e.key === 'ArrowDown') {
							newHashIndex = this.graph.getFirstParentIndex(curHashIndex);
						}
					}
				} else {
					// Up / Down navigates according to the order of commits in the table
					if (e.key === 'ArrowUp' && curHashIndex > 0) {
						newHashIndex = curHashIndex - 1;
					} else if (e.key === 'ArrowDown' && curHashIndex < this.commits.length - 1) {
						newHashIndex = curHashIndex + 1;
					}
				}

				if (newHashIndex > -1) {
					handledEvent(e);
					const elem = findCommitElemWithId(getCommitElems(), newHashIndex);
					if (elem !== null) this.loadCommitDetails(elem);
				}
			} else if (e.key && (e.ctrlKey || e.metaKey)) {
				if (chordInProgress) return; // Leave the second keypress of a chord to Visual Studio Code

				const key = e.key.toLowerCase(), keybindings = this.config.keybindings;
				if (key === keybindings.scrollToStash) {
					this.scrollToStash(!e.shiftKey);
					handledEvent(e);
				} else if (!e.shiftKey && key === keybindings.refresh) {
					this.refresh(true, true);
					handledEvent(e);
				} else if (!e.shiftKey && key === keybindings.find) {
					this.findWidget.show(true);
					handledEvent(e);
				} else if (!e.shiftKey && key === keybindings.scrollToHead && this.commitHead !== null) {
					this.scrollToHead();
					handledEvent(e);
				} else if (key === 'c' && !e.shiftKey && !e.altKey && this.copyCommitHashWithKeyboard(e)) {
					handledEvent(e);
				} else if (key.length === 1 && !['a', 'c', 'v', 'x', 'y', 'z'].includes(key)) {
					possibleChordStart = Date.now();
				}
			} else if (e.key === 'Escape') {
				if (this.isStashListOpen()) {
					this.closeStashList();
					handledEvent(e);
				} else if (this.repoDropdown.isOpen()) {
					this.repoDropdown.close();
					handledEvent(e);
				} else if (this.branchDropdown.isOpen()) {
					this.branchDropdown.close();
					handledEvent(e);
				} else if (this.authorDropdown.isOpen()) {
					this.authorDropdown.close();
					handledEvent(e);
				} else if (this.settingsWidget.isVisible()) {
					this.settingsWidget.close();
					handledEvent(e);
				} else if (this.findWidget.isVisible()) {
					this.findWidget.close();
					handledEvent(e);
				} else if (this.expandedCommit !== null) {
					this.closeCommitDetails(true);
					handledEvent(e);
				}
			}
		});
	}

	/**
	 * Copy the hash of the commit whose context menu is open, or whose details are shown, to the clipboard (Ctrl/Cmd+C), unless text is selected.
	 * @param e The keyboard event.
	 * @returns TRUE => A commit hash was copied, FALSE => Nothing was copied (the default behaviour of the keyboard shortcut applies).
	 */
	private copyCommitHashWithKeyboard(e: KeyboardEvent) {
		const selection = window.getSelection();
		if ((selection !== null && selection.toString() !== '') || (e.target instanceof Element && e.target.closest('input, textarea') !== null)) return false;
		const target = contextMenu.getTarget();
		const hash = target !== null && target.type === TargetType.Commit
			? target.hash
			: this.expandedCommit !== null && this.expandedCommit.compareWithHash === null && !contextMenu.isOpen() ? this.expandedCommit.commitHash : null;
		if (hash === null || hash === UNCOMMITTED) return false;
		sendMessage({ command: 'copyToClipboard', type: t('Commit Hash'), data: hash });
		closeDialogAndContextMenu();
		return true;
	}

	private observeUrls() {
		const followInternalLink = (e: MouseEvent) => {
			if (e.target !== null && isInternalUrlElem(<Element>e.target)) {
				const value = unescapeHtml((<HTMLElement>e.target).dataset.value!);
				switch ((<HTMLElement>e.target).dataset.type!) {
					case 'commit':
						if (typeof this.commitLookup[value] === 'number' && (this.expandedCommit === null || this.expandedCommit.commitHash !== value || this.expandedCommit.compareWithHash !== null)) {
							const elem = findCommitElemWithId(getCommitElems(), this.commitLookup[value]);
							if (elem !== null) this.loadCommitDetails(elem);
						}
						break;
				}
			}
		};

		document.body.addEventListener('click', followInternalLink);

		document.body.addEventListener('click', (e: MouseEvent) => {
			// Visual Studio Code only follows links with standard schemes (e.g. http & https) that are clicked in a Webview, so links to other applications (e.g. issue links using a custom scheme) are opened by the extension
			if (e.target === null || !isExternalUrlElem(<Element>e.target)) return;
			const url = (<HTMLAnchorElement>e.target).href;
			const scheme = url.substring(0, url.indexOf(':')).toLowerCase();
			if (/^[a-z][a-z0-9+.-]*$/.test(scheme) && !['http', 'https', 'mailto', 'file', 'javascript', 'data', 'vbscript', 'command', 'vscode', 'vscode-insiders'].includes(scheme)) {
				handledEvent(e);
				sendMessage({ command: 'openExternalUrl', url: url });
			}
		});

		document.body.addEventListener('contextmenu', (e: MouseEvent) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;

			const isExternalUrl = isExternalUrlElem(eventTarget), isInternalUrl = isInternalUrlElem(eventTarget);
			if (isExternalUrl || isInternalUrl) {
				const viewElem: HTMLElement | null = eventTarget.closest('#view');
				let eventElem: HTMLElement | null;

				let target: (ContextMenuTarget & CommitTarget) | RepoTarget, isInDialog = false;
				if (this.expandedCommit !== null && eventTarget.closest('#cdv') !== null) {
					// URL is in the Commit Details View
					target = {
						type: TargetType.CommitDetailsView,
						hash: this.expandedCommit.commitHash,
						index: this.commitLookup[this.expandedCommit.commitHash],
						elem: <HTMLElement>eventTarget
					};
					GitGraphView.closeCdvContextMenuIfOpen(this.expandedCommit);
					this.expandedCommit.contextMenuOpen.summary = true;
				} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
					// URL is in the Commits
					const commit = this.getCommitOfElem(eventElem);
					if (commit === null) return;
					target = {
						type: TargetType.Commit,
						hash: commit.hash,
						index: parseInt(eventElem.dataset.id!),
						elem: <HTMLElement>eventTarget
					};
				} else {
					// URL is in a dialog
					target = {
						type: TargetType.Repo
					};
					isInDialog = true;
				}

				handledEvent(e);
				contextMenu.show([
					[
						{
							title: t('Open URL'),
							visible: isExternalUrl,
							onClick: () => {
								sendMessage({ command: 'openExternalUrl', url: (<HTMLAnchorElement>eventTarget).href });
							}
						},
						{
							title: t('Follow Internal Link'),
							visible: isInternalUrl,
							onClick: () => followInternalLink(e)
						},
						{
							title: t('Copy URL to Clipboard'),
							visible: isExternalUrl,
							onClick: () => {
								sendMessage({ command: 'copyToClipboard', type: t('External URL'), data: (<HTMLAnchorElement>eventTarget).href });
							}
						}
					]
				], false, target, e, viewElem || document.body, () => {
					if (target.type === TargetType.CommitDetailsView && this.expandedCommit !== null) {
						this.expandedCommit.contextMenuOpen.summary = false;
					}
				}, isInDialog ? 'dialogContextMenu' : null);
			}
		});
	}

	private observeTableEvents() {

		// Register Click Event Handler
		this.tableElem.addEventListener('click', (e: MouseEvent) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;
			if (isUrlElem(eventTarget)) return;
			let eventElem: HTMLElement | null;

			if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
				// .gitRef was clicked
				e.stopPropagation();
				if (contextMenu.isOpen()) {
					contextMenu.close();
				}

			} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
				// .commit was clicked
				if (this.expandedCommit !== null) {
					const commit = this.getCommitOfElem(eventElem);
					if (commit === null) return;

					if (this.expandedCommit.commitHash === commit.hash) {
						this.closeCommitDetails(true);
					} else if ((<MouseEvent>e).ctrlKey || (<MouseEvent>e).metaKey || this.cdvComparePending) {
						this.cdvComparePending = false;
						if (this.expandedCommit.compareWithHash === commit.hash) {
							this.closeCommitComparison(true);
						} else if (this.expandedCommit.commitElem !== null) {
							this.loadCommitComparison(this.expandedCommit.commitElem, eventElem);
						}
					} else {
						this.loadCommitDetails(eventElem);
					}
				} else {
					this.loadCommitDetails(eventElem);
				}
			}
		});

		// Register Double Click Event Handler
		// Highlight the branch of the commit that the mouse is over (on the graph)
		let highlightedCommit: number | null = null;
		const highlightBranchOfCommit = (id: number | null) => {
			if (id === highlightedCommit) return;
			highlightedCommit = id;
			this.graph.highlightBranchOfCommit(id);
		};
		this.tableElem.addEventListener('mouseover', (e: MouseEvent) => {
			const commitElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.commit') : null;
			highlightBranchOfCommit(commitElem !== null && typeof commitElem.dataset.id === 'string' ? parseInt(commitElem.dataset.id) : null);
		});
		this.tableElem.addEventListener('mouseleave', () => highlightBranchOfCommit(null));

		this.tableElem.addEventListener('dblclick', (e: MouseEvent) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;
			if (isUrlElem(eventTarget)) return;
			let eventElem: HTMLElement | null;

			if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
				// .gitRef was double clicked
				e.stopPropagation();
				closeDialogAndContextMenu();
				const commitElem = <HTMLElement>eventElem.closest('.commit')!;
				const commit = this.getCommitOfElem(commitElem);
				if (commit === null) return;

				if (eventElem.classList.contains(CLASS_REF_HEAD) || eventElem.classList.contains(CLASS_REF_REMOTE)) {
					let sourceElem = <HTMLElement>eventElem.children[1];
					let refName = unescapeHtml(eventElem.dataset.name!), isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
					if (isHead && isRemoteCombinedWithHead) {
						refName = unescapeHtml((<HTMLElement>eventTarget).dataset.fullref!);
						sourceElem = <HTMLElement>eventTarget;
						isHead = false;
					}

					const target: ContextMenuTarget & DialogTarget & RefTarget = {
						type: TargetType.Ref,
						hash: commit.hash,
						index: parseInt(commitElem.dataset.id!),
						ref: refName,
						elem: sourceElem
					};

					this.checkoutBranchAction(refName, isHead ? null : unescapeHtml((isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!), null, target);
				}
			}
		});

		// Register ContextMenu Event Handler
		this.tableElem.addEventListener('contextmenu', (e: Event) => {
			if (e.target === null) return;
			const eventTarget = <Element>e.target;
			if (isUrlElem(eventTarget)) return;
			let eventElem: HTMLElement | null;

			if ((eventElem = eventTarget.closest('.gitRef')) !== null) {
				// .gitRef was right clicked
				handledEvent(e);
				const commitElem = <HTMLElement>eventElem.closest('.commit')!;
				const commit = this.getCommitOfElem(commitElem);
				if (commit === null) return;

				const target: ContextMenuTarget & DialogTarget & RefTarget = {
					type: TargetType.Ref,
					hash: commit.hash,
					index: parseInt(commitElem.dataset.id!),
					ref: unescapeHtml(eventElem.dataset.name!),
					elem: <HTMLElement>eventElem.children[1]
				};

				let actions: ContextMenuActions;
				if (eventElem.classList.contains(CLASS_REF_STASH)) {
					actions = this.getStashContextMenuActions(target);
				} else if (eventElem.classList.contains(CLASS_REF_TAG)) {
					actions = this.getTagContextMenuActions(eventElem.dataset.tagtype === 'annotated', target);
				} else {
					let isHead = eventElem.classList.contains(CLASS_REF_HEAD), isRemoteCombinedWithHead = eventTarget.classList.contains('gitRefHeadRemote');
					if (isHead && isRemoteCombinedWithHead) {
						target.ref = unescapeHtml((<HTMLElement>eventTarget).dataset.fullref!);
						target.elem = <HTMLElement>eventTarget;
						isHead = false;
					}
					if (isHead) {
						actions = this.getBranchContextMenuActions(target);
					} else {
						const remote = unescapeHtml((isRemoteCombinedWithHead ? <HTMLElement>eventTarget : eventElem).dataset.remote!);
						actions = this.getRemoteBranchContextMenuActions(remote, target);
					}
				}

				contextMenu.show(actions, false, target, <MouseEvent>e, this.viewElem);

			} else if ((eventElem = eventTarget.closest('.commit')) !== null) {
				// .commit was right clicked
				handledEvent(e);
				const commit = this.getCommitOfElem(eventElem);
				if (commit === null) return;

				const target: ContextMenuTarget & DialogTarget & CommitTarget = {
					type: TargetType.Commit,
					hash: commit.hash,
					index: parseInt(eventElem.dataset.id!),
					elem: eventElem
				};

				let actions: ContextMenuActions;
				if (commit.hash === UNCOMMITTED) {
					actions = this.getUncommittedChangesContextMenuActions(target);
				} else if (commit.stash !== null) {
					target.ref = commit.stash.selector;
					actions = this.getStashContextMenuActions(<RefTarget>target);
				} else {
					actions = this.getCommitContextMenuActions(target);
				}

				contextMenu.show(actions, false, target, <MouseEvent>e, this.viewElem);
			}
		});

		// When a context menu is requested with the keyboard (e.g. the Menu key or Shift+F10), show the context menu of the commit selected with the keyboard
		document.addEventListener('contextmenu', (e: MouseEvent) => {
			if (e.button === 2 || (e.target !== document.body && e.target !== document.documentElement && e.target !== this.viewElem)) return;
			if (this.expandedCommit === null || this.expandedCommit.commitElem === null || dialog.isOpen()) return;

			handledEvent(e);
			const bounds = this.expandedCommit.commitElem.getBoundingClientRect();
			this.expandedCommit.commitElem.dispatchEvent(new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				button: 2,
				clientX: Math.round(bounds.left + Math.min(bounds.width / 2, 200)),
				clientY: Math.round(bounds.top + bounds.height / 2)
			}));
		}, true);
	}


	/* Commit Details View */

	public loadCommitDetails(commitElem: HTMLElement) {
		const commit = this.getCommitOfElem(commitElem);
		if (commit === null) return;

		this.closeCommitDetails(false);
		this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, null, null);
		commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		this.renderCommitDetailsView(false);
		this.requestCommitDetails(commit.hash, false);
	}

	public closeCommitDetails(saveAndRender: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null) return;

		const elem = document.getElementById('cdv'), isDocked = this.isCdvDocked();
		this.cdvComparePending = false;
		this.cdvShowWholeCommit = false;
		if (elem !== null) {
			elem.remove();
		}
		if (isDocked) {
			this.viewElem.style.bottom = '0px';
			this.viewElem.style.right = '0px';
			document.body.classList.remove(CLASS_CDV_DOCKED_RIGHT);
		}
		if (expandedCommit.commitElem !== null) {
			expandedCommit.commitElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		if (expandedCommit.compareWithElem !== null) {
			expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		this.expandedCommit = null;
		if (saveAndRender) {
			this.saveState();
			if (!isDocked) {
				this.renderGraph();
			}
		}
	}

	public showCommitDetails(commitDetails: GG.GitCommitDetails, fileTree: FileTreeFolder, avatar: string | null, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.commitHash !== commitDetails.hash || expandedCommit.compareWithHash !== null) return;

		if (!this.isCdvDocked()) {
			const elem = document.getElementById('cdv');
			if (elem !== null) elem.remove();
		}

		expandedCommit.commitDetails = commitDetails;
		if (haveFilesChanged(expandedCommit.fileChanges, commitDetails.fileChanges)) {
			expandedCommit.fileChanges = commitDetails.fileChanges;
			expandedCommit.fileTree = fileTree;
			GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		}
		expandedCommit.avatar = avatar;
		expandedCommit.codeReview = codeReview;
		if (!refresh) {
			expandedCommit.lastViewedFile = lastViewedFile;
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.loading = false;
		this.saveState();

		this.renderCommitDetailsView(refresh);
	}

	public createFileTree(gitFiles: ReadonlyArray<GG.GitFileChange>, codeReview: GG.CodeReview | null) {
		let contents: FileTreeFolderContents = {}, i, j, path, absPath, cur: FileTreeFolder;
		let files: FileTreeFolder = { type: 'folder', name: '', folderPath: '', contents: contents, open: true, reviewed: true };

		for (i = 0; i < gitFiles.length; i++) {
			cur = files;
			path = gitFiles[i].newFilePath.split('/');
			absPath = this.currentRepo;
			for (j = 0; j < path.length; j++) {
				absPath += '/' + path[j];
				if (typeof this.gitRepos[absPath] !== 'undefined') {
					if (typeof cur.contents[path[j]] === 'undefined') {
						cur.contents[path[j]] = { type: 'repo', name: path[j], path: absPath };
					}
					break;
				} else if (j < path.length - 1) {
					if (typeof cur.contents[path[j]] === 'undefined') {
						contents = {};
						cur.contents[path[j]] = { type: 'folder', name: path[j], folderPath: absPath.substring(this.currentRepo.length + 1), contents: contents, open: true, reviewed: true };
					}
					cur = <FileTreeFolder>cur.contents[path[j]];
				} else if (path[j] !== '') {
					cur.contents[path[j]] = { type: 'file', name: path[j], index: i, reviewed: codeReview === null || !codeReview.remainingFiles.includes(gitFiles[i].newFilePath) };
				}
			}
		}
		if (codeReview !== null) calcFileTreeFoldersReviewed(files);
		return files;
	}


	/* Commit Comparison View */

	private loadCommitComparison(commitElem: HTMLElement, compareWithElem: HTMLElement) {
		const commit = this.getCommitOfElem(commitElem);
		const compareWithCommit = this.getCommitOfElem(compareWithElem);

		if (commit !== null && compareWithCommit !== null) {
			if (this.expandedCommit !== null) {
				if (this.expandedCommit.commitHash !== commit.hash) {
					this.closeCommitDetails(false);
				} else if (this.expandedCommit.compareWithHash !== compareWithCommit.hash) {
					this.closeCommitComparison(false);
				}
			}

			this.saveExpandedCommitLoading(parseInt(commitElem.dataset.id!), commit.hash, commitElem, compareWithCommit.hash, compareWithElem);
			commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
			compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
			this.renderCommitDetailsView(false);
			this.requestCommitComparison(commit.hash, compareWithCommit.hash, false);
		}
	}

	public closeCommitComparison(saveAndRequestCommitDetails: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.compareWithHash === null) return;

		if (expandedCommit.compareWithElem !== null) {
			expandedCommit.compareWithElem.classList.remove(CLASS_COMMIT_DETAILS_OPEN);
		}
		GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		if (saveAndRequestCommitDetails) {
			if (expandedCommit.commitElem !== null) {
				this.saveExpandedCommitLoading(expandedCommit.index, expandedCommit.commitHash, expandedCommit.commitElem, null, null);
				this.renderCommitDetailsView(false);
				this.requestCommitDetails(expandedCommit.commitHash, false);
			} else {
				this.closeCommitDetails(true);
			}
		}
	}

	public showCommitComparison(commitHash: string, compareWithHash: string, fileChanges: ReadonlyArray<GG.GitFileChange>, fileTree: FileTreeFolder, codeReview: GG.CodeReview | null, lastViewedFile: string | null, refresh: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null || expandedCommit.compareWithElem === null || expandedCommit.commitHash !== commitHash || expandedCommit.compareWithHash !== compareWithHash) return;

		if (haveFilesChanged(expandedCommit.fileChanges, fileChanges)) {
			expandedCommit.fileChanges = fileChanges;
			expandedCommit.fileTree = fileTree;
			GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		}
		expandedCommit.codeReview = codeReview;
		if (!refresh) {
			expandedCommit.lastViewedFile = lastViewedFile;
		}
		expandedCommit.commitElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.compareWithElem.classList.add(CLASS_COMMIT_DETAILS_OPEN);
		expandedCommit.loading = false;
		this.saveState();

		this.renderCommitDetailsView(refresh);
	}


	/* Render Commit Details / Comparison View */

	private renderCommitDetailsView(refresh: boolean) {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.commitElem === null) return;

		let elem = document.getElementById('cdv'), html = '<div id="cdvContent">', isDocked = this.isCdvDocked(), messageHtml = '';
		const isRight = isDocked && this.isCdvDockedRight();
		const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		const codeReviewPossible = !expandedCommit.loading && commitOrder.to !== UNCOMMITTED;
		const externalDiffPossible = !expandedCommit.loading && (expandedCommit.compareWithHash !== null || this.commits[this.commitLookup[expandedCommit.commitHash]].parents.length > 0);

		if (elem === null) {
			elem = document.createElement(isDocked ? 'div' : 'tr');
			elem.id = 'cdv';
			elem.className = isDocked ? (this.isCdvDockedRight() ? 'docked right' : 'docked') : 'inline';
			this.setCdvHeight(elem, isDocked);
			if (isDocked) {
				document.body.appendChild(elem);
			} else {
				insertAfter(elem, expandedCommit.commitElem);
			}
		}

		if (expandedCommit.loading) {
			html += '<div id="cdvLoading">' + SVG_ICONS.loading + ' ' + t('Loading {0} ...', expandedCommit.compareWithHash === null ? expandedCommit.commitHash !== UNCOMMITTED ? t('Commit Details') : t('Uncommitted Changes') : t('Commit Comparison')) + '</div>';
		} else {
			html += '<div id="cdvSummary">';
			if (expandedCommit.compareWithHash === null) {
				// Commit details should be shown
				if (expandedCommit.commitHash !== UNCOMMITTED) {
					const textFormatter = new TextFormatter(this.commits, this.gitRepos[this.currentRepo].issueLinkingConfig, {
						commits: true,
						emoji: true,
						issueLinking: true,
						markdown: this.config.markdown,
						multiline: true,
						urls: true
					});
					const commitDetails = expandedCommit.commitDetails!;
					const parents = commitDetails.parents.length > 0
						? commitDetails.parents.map((parent) => {
							const escapedParent = escapeHtml(parent);
							return typeof this.commitLookup[parent] === 'number'
								? '<span class="' + CLASS_INTERNAL_URL + '" data-type="commit" data-value="' + escapedParent + '" tabindex="-1">' + escapedParent + '</span>'
								: escapedParent;
						}).join(', ')
						: t('None');
					const subjectEnd = commitDetails.body.indexOf('\n');
					const subject = subjectEnd > -1 ? commitDetails.body.substring(0, subjectEnd) : commitDetails.body;
					const body = subjectEnd > -1 ? commitDetails.body.substring(subjectEnd + 1).trim() : '';
					const detail = (key: string, value: string) => '<span class="cdvSummaryKey">' + key + '</span><span class="cdvSummaryValue">' + value + '</span>';
					const detailsHtml = '<div class="cdvSummaryDetails">'
						+ detail(t('Commit:'), '<span class="cdvSummaryHash">' + escapeHtml(commitDetails.hash) + '</span>')
						+ detail(t('Parents:'), parents)
						+ detail(t('Author:'), escapeHtml(commitDetails.author) + (commitDetails.authorEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.authorEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.authorEmail) + '</a>&gt;' : ''))
						+ (commitDetails.authorDate !== commitDetails.committerDate ? detail(t('Author Date:'), formatLongDate(commitDetails.authorDate)) : '')
						+ detail(t('Committer:'), escapeHtml(commitDetails.committer) + (commitDetails.committerEmail !== '' ? ' &lt;<a class="' + CLASS_EXTERNAL_URL + '" href="mailto:' + escapeHtml(commitDetails.committerEmail) + '" tabindex="-1">' + escapeHtml(commitDetails.committerEmail) + '</a>&gt;' : '') + (commitDetails.signature !== null ? generateSignatureHtml(commitDetails.signature) : ''))
						+ detail(commitDetails.authorDate !== commitDetails.committerDate ? t('Committer Date:') : t('Date:'), formatLongDate(commitDetails.committerDate))
						+ '</div>';
					if (isRight) {
						html += this.generateCdvSummaryHtml(commitDetails, expandedCommit.avatar, expandedCommit.fileChanges!, textFormatter, subject, body);
						messageHtml = '<div class="cdvMessageText">' + textFormatter.format(commitDetails.body) + '</div>' + detailsHtml;
					} else html += '<div class="cdvSummaryHeader">'
						+ (expandedCommit.avatar !== null ? '<span class="cdvSummaryAvatar"><img src="' + expandedCommit.avatar + '"></span>' : generateAuthorInitialHtml(commitDetails.author))
						+ '<span class="cdvSummaryHeaderText"><span class="cdvSummaryAuthor">' + escapeHtml(commitDetails.author) + '</span><span class="cdvSummaryDate" title="' + escapeHtml(formatLongDate(commitDetails.authorDate)) + '">' + formatShortDate(commitDetails.authorDate).formatted + '</span></span>'
						+ '</div>'
						+ '<div class="cdvSummarySubject">' + textFormatter.format(subject) + '</div>'
						+ (body !== '' ? '<div class="cdvSummaryBody">' + textFormatter.format(body) + '</div>' : '')
						+ detailsHtml + '<div id="cdvActions"></div>';
				} else {
					html += (isRight ? '<h2 class="cdvSubject">' + t('Uncommitted Changes') + '</h2>' : '') + '<p class="cdvSummaryText">' + t('Displaying all uncommitted changes.') + '</p>' + (isRight ? generateCdvStatsHtml(expandedCommit.fileChanges!) : '') + '<div id="cdvActions"></div>';
				}
			} else {
				// Commit comparison should be shown
				html += '<p class="cdvSummaryText">' + t('Displaying all changes from <b>{0}</b> to <b>{1}</b>.', commitOrder.from, (commitOrder.to !== UNCOMMITTED ? commitOrder.to : t('Uncommitted Changes'))) + '</p>' + (isRight ? generateCdvStatsHtml(expandedCommit.fileChanges!) : '');
			}
			const fileViewHtml = generateFileViewHtml(expandedCommit.fileTree!, expandedCommit.fileChanges!, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, this.getFileViewType(), commitOrder.to === UNCOMMITTED);
			html += '</div><div id="cdvFiles">' + (isRight
				? '<div id="cdvTabs"><span class="cdvTab active" data-tab="files">' + t('Changed Files') + ' · ' + expandedCommit.fileChanges!.length + '</span>' + (messageHtml !== '' ? '<span class="cdvTab" data-tab="message">' + t('Commit Message') + '</span>' : '') + '<span class="cdvTabsSpacer"></span>' +
					'<div id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File Tree View') + '">' + SVG_ICONS.fileTree + '</div><div id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File List View') + '">' + SVG_ICONS.fileList + '</div></div>' +
					'<div id="cdvFileView">' + fileViewHtml + '</div>' + (messageHtml !== '' ? '<div id="cdvMessageView" class="hidden">' + messageHtml + '</div>' : '')
				: fileViewHtml) + '</div><div id="cdvDivider"></div>';
		}
		if (isRight) {
			const title = expandedCommit.compareWithHash !== null ? t('Commit Comparison') : expandedCommit.commitHash === UNCOMMITTED ? t('Uncommitted Changes')
				: !expandedCommit.loading && expandedCommit.fileChanges !== null && this.getCdvFileFocus(expandedCommit.commitHash, expandedCommit.fileChanges) !== null ? t('Changes to this File in the Commit') : t('Commit Details');
			html = '<div id="cdvHeader"><span class="cdvHeaderTitle">' + title + '</span>' +
				(codeReviewPossible ? '<div id="cdvCodeReview" class="cdvControlBtn">' + SVG_ICONS.review + '</div>' : '') +
				(externalDiffPossible ? '<div id="cdvExternalDiff" class="cdvControlBtn">' + SVG_ICONS.linkExternal + '</div>' : '') +
				(expandedCommit.compareWithHash === null ? '<div id="cdvPrev" class="cdvControlBtn" title="' + t('Previous Commit') + '">' + SVG_ICONS.arrowUp + '</div><div id="cdvNext" class="cdvControlBtn" title="' + t('Next Commit') + '">' + SVG_ICONS.arrowDown + '</div>' : '') +
				'<div id="cdvClose" class="cdvControlBtn" title="' + t('Close') + '">' + SVG_ICONS.close + '</div></div>' +
				html + '</div><div class="cdvHeightResize"></div>';
		} else {
			html += '</div><div id="cdvControls"><div id="cdvClose" class="cdvControlBtn" title="' + t('Close') + '">' + SVG_ICONS.close + '</div>' +
				(codeReviewPossible ? '<div id="cdvCodeReview" class="cdvControlBtn">' + SVG_ICONS.review + '</div>' : '') +
				(!expandedCommit.loading ? '<div id="cdvFileViewTypeTree" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File Tree View') + '">' + SVG_ICONS.fileTree + '</div><div id="cdvFileViewTypeList" class="cdvControlBtn cdvFileViewTypeBtn" title="' + t('File List View') + '">' + SVG_ICONS.fileList + '</div>' : '') +
				(externalDiffPossible ? '<div id="cdvExternalDiff" class="cdvControlBtn">' + SVG_ICONS.linkExternal + '</div>' : '') +
				'</div><div class="cdvHeightResize"></div>';
		}

		elem.innerHTML = isDocked ? html : '<td><div class="cdvHeightResize"></div></td><td colspan="' + (this.getNumColumns() - 1) + '">' + html + '</td>';
		if (!expandedCommit.loading) this.setCdvDivider();
		if (!isDocked) this.renderGraph();

		if (!refresh) {
			if (isDocked) {
				const headerHeight = this.controlsElem.clientHeight, elemTop = headerHeight + expandedCommit.commitElem.offsetTop;
				if (elemTop - 8 < this.viewElem.scrollTop + headerHeight) {
					// Commit is above what is visible on screen (below the sticky controls)
					this.viewElem.scroll(0, elemTop - headerHeight - 8);
				} else if (elemTop - this.viewElem.clientHeight + 32 > this.viewElem.scrollTop) {
					// Commit is below what is visible on screen
					this.viewElem.scroll(0, elemTop - this.viewElem.clientHeight + 32);
				}
			} else {
				const headerHeight = this.controlsElem.clientHeight, elemTop = headerHeight + elem.offsetTop, cdvHeight = this.gitRepos[this.currentRepo].cdvHeight;
				if (this.config.commitDetailsView.autoCenter) {
					// Center Commit Detail View setting is enabled (in the area below the sticky controls)
					// elemTop - commit height [24px] + (commit details view height + commit height [24px]) / 2 - (view height + controls height) / 2
					this.viewElem.scroll(0, elemTop - 12 + (cdvHeight - this.viewElem.clientHeight - headerHeight) / 2);
				} else if (elemTop - 32 < this.viewElem.scrollTop + headerHeight) {
					// Commit Detail View is opening above what is visible on screen (below the sticky controls)
					// elemTop - commit height [24px] - desired gap from top [8px] < view scroll offset + controls height
					this.viewElem.scroll(0, elemTop - headerHeight - 32);
				} else if (elemTop + cdvHeight - this.viewElem.clientHeight + 8 > this.viewElem.scrollTop) {
					// Commit Detail View is opening below what is visible on screen
					// elemTop + commit details view height + desired gap from bottom [8px] - view height > view scroll offset
					this.viewElem.scroll(0, elemTop + cdvHeight - this.viewElem.clientHeight + 8);
				}
			}
		}

		this.makeCdvResizable();
		document.getElementById('cdvClose')!.addEventListener('click', () => {
			this.closeCommitDetails(true);
		});

		if (isRight) this.makeCdvHeaderInteractive();
		if (isRight && !expandedCommit.loading) this.makeCdvFileFocusInteractive();

		if (!expandedCommit.loading) {
			this.makeCdvFileViewInteractive();
			this.renderCdvActions();
			this.renderCdvFileViewTypeBtns();
			this.renderCdvExternalDiffBtn();
			this.makeCdvDividerDraggable();

			observeElemScroll('cdvSummary', expandedCommit.scrollTop.summary, (scrollTop) => {
				if (this.expandedCommit === null) return;
				this.expandedCommit.scrollTop.summary = scrollTop;
				if (this.expandedCommit.contextMenuOpen.summary) {
					this.expandedCommit.contextMenuOpen.summary = false;
					contextMenu.close();
				}
			}, () => this.saveState());

			observeElemScroll(isRight ? 'cdvContent' : 'cdvFiles', expandedCommit.scrollTop.fileView, (scrollTop) => {
				if (this.expandedCommit === null) return;
				this.expandedCommit.scrollTop.fileView = scrollTop;
				if (this.expandedCommit.contextMenuOpen.fileView > -1) {
					this.expandedCommit.contextMenuOpen.fileView = -1;
					contextMenu.close();
				}
			}, () => this.saveState());

			document.getElementById('cdvFileViewTypeTree')!.addEventListener('click', () => {
				this.changeFileViewType(GG.FileViewType.Tree);
			});

			document.getElementById('cdvFileViewTypeList')!.addEventListener('click', () => {
				this.changeFileViewType(GG.FileViewType.List);
			});

			if (codeReviewPossible) {
				this.renderCodeReviewBtn();
				document.getElementById('cdvCodeReview')!.addEventListener('click', (e) => {
					const expandedCommit = this.expandedCommit;
					if (expandedCommit === null || e.target === null) return;
					let sourceElem = <HTMLElement>(<Element>e.target).closest('#cdvCodeReview')!;
					if (sourceElem.classList.contains(CLASS_ACTIVE)) {
						sendMessage({ command: 'endCodeReview', repo: this.currentRepo, id: expandedCommit.codeReview!.id });
						this.endCodeReview();
					} else {
						const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
						const id = expandedCommit.compareWithHash !== null ? commitOrder.from + '-' + commitOrder.to : expandedCommit.commitHash;
						sendMessage({
							command: 'startCodeReview',
							repo: this.currentRepo,
							id: id,
							commitHash: expandedCommit.commitHash,
							compareWithHash: expandedCommit.compareWithHash,
							files: getFilesInTree(expandedCommit.fileTree!, expandedCommit.fileChanges!),
							lastViewedFile: expandedCommit.lastViewedFile
						});
					}
				});
			}

			if (externalDiffPossible) {
				document.getElementById('cdvExternalDiff')!.addEventListener('click', () => {
					const expandedCommit = this.expandedCommit;
					if (expandedCommit === null || this.gitConfig === null || (this.gitConfig.diffTool === null && this.gitConfig.guiDiffTool === null)) return;
					const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
					runAction({
						command: 'openExternalDirDiff',
						repo: this.currentRepo,
						fromHash: commitOrder.from,
						toHash: commitOrder.to,
						isGui: this.gitConfig.guiDiffTool !== null
					}, t('Opening External Directory Diff'));
				});
			}
		}
	}

	/**
	 * Generate the HTML of the summary of a commit, in the Commit Details View docked to the right.
	 * @param commitDetails The details of the commit.
	 * @param avatar The avatar of the commit's author (if available).
	 * @param fileChanges The files changed by the commit.
	 * @param textFormatter The TextFormatter used to format the commit message.
	 * @param subject The subject of the commit message.
	 * @param body The body of the commit message.
	 * @returns The HTML.
	 */
	private generateCdvSummaryHtml(commitDetails: GG.GitCommitDetails, avatar: string | null, fileChanges: ReadonlyArray<GG.GitFileChange>, textFormatter: TextFormatter, subject: string, body: string) {
		const index = this.commitLookup[commitDetails.hash];
		const issues = this.getIssueLinks(commitDetails.body);
		const branches = typeof index === 'number' ? this.getBranchesContainingCommit(index) : [];
		const remoteUrl = this.getRemoteCommitUrl(commitDetails.hash);
		return '<div class="cdvAuthor">' + (avatar !== null ? '<span class="cdvSummaryAvatar"><img src="' + avatar + '"></span>' : generateAuthorInitialHtml(commitDetails.author)) +
			'<span class="cdvAuthorText"><span><b>' + escapeHtml(commitDetails.author) + '</b>' + (commitDetails.authorEmail !== '' ? ' <span class="cdvMuted">&lt;' + escapeHtml(commitDetails.authorEmail) + '&gt;</span>' : '') + '</span>' +
			'<span class="cdvMuted" title="' + escapeHtml(formatLongDate(commitDetails.committerDate)) + '">' + t('Committed {0}', formatRelativeDate(commitDetails.committerDate)) + ' · ' + formatIsoDateTime(commitDetails.committerDate) + '</span></span></div>' +
			'<div class="cdvChips"><button type="button" id="cdvCopyHash" class="cdvChip mono" title="' + t('Copy Commit Hash to Clipboard') + '" tabindex="-1">' + SVG_ICONS.copy + escapeHtml(abbrevCommit(commitDetails.hash)) + '</button>' +
			(remoteUrl !== null ? '<button type="button" id="cdvOpenOnRemote" class="cdvChip" title="' + escapeHtml(remoteUrl) + '" tabindex="-1">' + SVG_ICONS.linkExternal + t('Open on Remote') + '</button>' : '') +
			'<button type="button" id="cdvCompare" class="cdvChip' + (this.cdvComparePending ? ' active' : '') + '" title="' + t('Click on another commit to compare it with this commit') + '" tabindex="-1">' + SVG_ICONS.compare + (this.cdvComparePending ? t('Click on a commit to compare with') : t('Compare with…')) + '</button></div>' +
			'<h2 class="cdvSubject">' + textFormatter.format(subject) + '</h2>' +
			(body !== '' ? '<div class="cdvBody">' + textFormatter.format(body) + '</div>' : '') +
			(this.getCdvFileFocus(commitDetails.hash, fileChanges) !== null ? this.generateCdvFileFocusHtml(commitDetails.hash, fileChanges) : (issues.length > 0 ? '<div class="cdvLine"><span class="cdvMuted">' + t('Related Issues') + '</span>' + issues.map((issue) => '<a class="' + CLASS_EXTERNAL_URL + '" href="' + escapeHtml(issue.url) + '" tabindex="-1">' + escapeHtml(issue.label) + '</a>').join('') + '</div>' : '') +
			(branches.length > 0 ? '<div class="cdvLine"><span class="cdvMuted">' + t('On Branches') + '</span>' + branches.map((branch) => '<span class="cdvBranch' + (branch.remote ? ' remote' : '') + '" style="--git-graph-color:' + escapeHtml(branch.colour) + '">' + escapeHtml(branch.name) + '</span>').join('') + '</div>' : '') +
			generateCdvStatsHtml(fileChanges) +
			'<div id="cdvActions"></div>');
	}

	/**
	 * Get the file the Commit Details View docked to the right focuses on: the file whose history is shown (unless the whole commit is shown).
	 * @param hash The hash of the commit.
	 * @param fileChanges The files changed by the commit.
	 * @returns The index of the file in the files changed by the commit, or NULL if the Commit Details View doesn't focus on a file.
	 */
	private getCdvFileFocus(hash: string, fileChanges: ReadonlyArray<GG.GitFileChange>) {
		if (this.fileHistory === null || this.cdvShowWholeCommit || !this.isCdvDocked() || !this.isCdvDockedRight()) return null;
		const historyCommit = this.fileHistoryData !== null ? this.fileHistoryData.commits[hash] : undefined;
		const filePath = typeof historyCommit !== 'undefined' ? historyCommit.filePath : this.fileHistory;
		const index = fileChanges.findIndex((file) => file.newFilePath === filePath || file.oldFilePath === filePath);
		return index > -1 ? index : null;
	}

	/**
	 * Generate the HTML of the changes made by a commit to the file whose history is shown, in the Commit Details View docked to the right.
	 * @param hash The hash of the commit.
	 * @param fileChanges The files changed by the commit.
	 * @returns The HTML.
	 */
	private generateCdvFileFocusHtml(hash: string, fileChanges: ReadonlyArray<GG.GitFileChange>) {
		const file = fileChanges[this.getCdvFileFocus(hash, fileChanges)!], textFile = file.additions !== null && file.deletions !== null;
		return '<div id="cdvFileFocus"><div class="cdvFileFocusFile"><span class="fileTreeFileBadge ' + file.type + '">' + file.type + '</span>' + fileIcons.getFileIcon(file.newFilePath) +
			'<span class="cdvFileFocusPath" title="' + escapeHtml(file.newFilePath) + '">' + escapeHtml(file.newFilePath) + '</span>' +
			(textFile ? '<span class="fileTreeFileAdd">+' + file.additions + '</span><span class="fileTreeFileDel">\u2212' + file.deletions + '</span>' + generateChangeBarHtml(file.additions!, file.deletions!, null) : '') + '</div>' +
			(file.type === GG.GitFileStatus.Renamed ? '<div class="cdvFileFocusRenamed">\u21aa ' + t('Renamed from {0}', escapeHtml(file.oldFilePath)) + '</div>' : '') +
			'<div class="cdvFileFocusActions"><button type="button" id="cdvFileFocusDiff" class="cdvActionBtn primary" tabindex="-1">' + t('Open in Diff Editor') + '</button>' +
			(file.type !== GG.GitFileStatus.Deleted ? '<button type="button" id="cdvFileFocusOpen" class="cdvActionBtn" tabindex="-1">' + t('Open This Version') + '</button>' : '') +
			'<button type="button" id="cdvFileFocusAll" class="cdvActionBtn" tabindex="-1">' + t('View the Whole Commit ({0} files)', fileChanges.length) + '</button></div>' +
			'<div id="cdvFileDiff">' + this.generateCdvFileDiffHtml(hash, file) + '</div></div>';
	}

	/**
	 * Generate the HTML of the diff of the file the Commit Details View focuses on (requesting it from the extension if it hasn't been loaded).
	 * @param hash The hash of the commit.
	 * @param file The file.
	 * @returns The HTML.
	 */
	private generateCdvFileDiffHtml(hash: string, file: GG.GitFileChange) {
		const key = hash + ':' + file.newFilePath;
		if (this.cdvFileDiff === null || this.cdvFileDiff.key !== key) {
			this.cdvFileDiff = { key: key, diff: null, error: null };
			const commit = this.commits[this.commitLookup[hash]];
			const parentHash = this.expandedCommit !== null && this.expandedCommit.commitDetails !== null && this.expandedCommit.commitDetails.hash === hash
				? (this.expandedCommit.commitDetails.parents.length > 0 ? this.expandedCommit.commitDetails.parents[0] : null)
				: (typeof commit !== 'undefined' && commit.parents.length > 0 ? commit.parents[0] : null);
			sendMessage({ command: 'loadFileDiff', repo: this.currentRepo, commitHash: hash, parentHash: parentHash, oldFilePath: file.oldFilePath, newFilePath: file.newFilePath });
		}
		return this.cdvFileDiff.diff !== null
			? generateFileDiffHtml(this.cdvFileDiff.diff, 40)
			: '<div class="cdvFileDiffMessage">' + (this.cdvFileDiff.error !== null ? escapeHtml(this.cdvFileDiff.error) : t('Loading the changes') + ELLIPSIS) + '</div>';
	}

	/**
	 * Process the diff of a file loaded by the extension, for the Commit Details View.
	 * @param msg The message containing the diff.
	 */
	public processLoadFileDiffResponse(msg: GG.ResponseLoadFileDiff) {
		const key = msg.commitHash + ':' + msg.filePath;
		if (this.cdvFileDiff === null || this.cdvFileDiff.key !== key) return;
		this.cdvFileDiff = { key: key, diff: msg.error === null ? msg.diff : null, error: msg.error };
		const diffElem = document.getElementById('cdvFileDiff');
		if (diffElem === null || this.expandedCommit === null || this.expandedCommit.fileChanges === null) return;
		const index = this.getCdvFileFocus(msg.commitHash, this.expandedCommit.fileChanges);
		if (index !== null) diffElem.innerHTML = this.generateCdvFileDiffHtml(msg.commitHash, this.expandedCommit.fileChanges[index]);
	}

	/**
	 * Add the event listeners to the changes to the file the Commit Details View focuses on.
	 */
	private makeCdvFileFocusInteractive() {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null || expandedCommit.fileChanges === null || document.getElementById('cdvFileFocus') === null) return;
		const index = this.getCdvFileFocus(expandedCommit.commitHash, expandedCommit.fileChanges);
		if (index === null) return;
		// The actions are performed on the file in the file view, so that its state (e.g. the last file viewed, and the files reviewed) is updated
		const clickFileView = (selector: string) => {
			const elem = document.querySelector('#cdvFileView .fileTreeFileRecord[data-index="' + index + '"] ' + selector);
			if (elem !== null) elem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		};
		const diffElem = document.getElementById('cdvFileFocusDiff'), openElem = document.getElementById('cdvFileFocusOpen'), allElem = document.getElementById('cdvFileFocusAll');
		if (diffElem !== null) diffElem.addEventListener('click', () => clickFileView('.fileTreeFile'));
		if (openElem !== null) openElem.addEventListener('click', () => clickFileView('.viewGitFileAtRevision'));
		if (allElem !== null) allElem.addEventListener('click', () => {
			this.cdvShowWholeCommit = true;
			this.renderCommitDetailsView(true);
		});
		document.getElementById('cdvFileDiff')!.addEventListener('click', (e) => {
			if ((<Element>e.target).closest('.cdvFileDiffOpen') !== null) clickFileView('.fileTreeFile');
		});
	}

	/**
	 * Show the history of a file (only the commits that change it), or all commits.
	 * @param filePath The path of the file, or NULL to show all commits.
	 */
	public setFileHistory(filePath: string | null) {
		if (filePath === this.fileHistory) return;
		this.fileHistory = filePath;
		this.fileHistoryData = null;
		this.cdvShowWholeCommit = false;
		this.maxCommits = this.config.initialLoadCommits;
		this.renderFileHistoryBar();
		this.saveState();
		this.clearCommits();
		this.requestLoadRepoInfoAndCommits(true, true);
	}

	/**
	 * Render the bar shown below the control bar when the history of a file is shown.
	 */
	private renderFileHistoryBar() {
		const elem = document.getElementById('fileHistoryBar');
		if (elem === null) return;
		alterClass(elem, CLASS_ACTIVE, this.fileHistory !== null);
		alterClass(document.body, 'fileHistory', this.fileHistory !== null);
		if (this.fileHistory === null) {
			elem.innerHTML = '';
			return;
		}
		const commits = this.loadedCommits.filter((commit) => commit.hash !== UNCOMMITTED && commit.stash === null), count = commits.length;
		const authors = new Set(commits.map((commit) => commit.author)).size, renames = this.fileHistoryData !== null ? this.fileHistoryData.paths.length - 1 : 0;
		const allBranches = this.currentBranches === null || this.currentBranches.includes(SHOW_ALL_BRANCHES);
		const currentBranch = this.gitBranchHead !== null && this.currentBranches !== null && this.currentBranches.length === 1 && this.currentBranches[0] === this.gitBranchHead;
		const summary = [
			this.moreCommitsAvailable ? t('{0}+ commits', count) : count !== 1 ? t('{0} commits', count) : t('{0} commit', count),
			authors !== 1 ? t('{0} authors', authors) : t('{0} author', authors)
		].concat(renames > 0 ? [renames !== 1 ? t('followed {0} renames', renames) : t('followed 1 rename')] : []);
		elem.innerHTML = fileIcons.getFileIcon(this.fileHistory) + '<b>' + t('File History') + '</b>' +
			'<span class="fileHistoryPath" title="' + escapeHtml(this.fileHistory) + '"><span>' + escapeHtml(this.fileHistory) + '</span><span id="fileHistoryCopy" title="' + t('Copy Relative File Path to Clipboard') + '">' + SVG_ICONS.copy + '</span></span>' +
			'<span class="fileHistorySummary">' + summary.join(' · ') + '</span><span class="fileHistorySpacer"></span>' +
			'<span id="fileHistoryBranches" role="group"><span class="fileHistoryBranchesOption' + (allBranches ? ' active' : '') + '" data-value="all">' + t('All Branches') + '</span><span class="fileHistoryBranchesOption' + (currentBranch ? ' active' : '') + (this.gitBranchHead === null ? ' disabled' : '') + '" data-value="current">' + t('Current Branch') + '</span></span>' +
			'<span id="fileHistoryOpen" class="fileHistoryBtn">' + SVG_ICONS.openFile + t('Open in Editor') + '</span>' +
			'<span id="fileHistoryExit" class="fileHistoryBtn exit" title="' + t('Show all of the commits') + '">' + t('Exit File History') + SVG_ICONS.close + '</span>';

		const filePath = this.fileHistory;
		document.getElementById('fileHistoryCopy')!.addEventListener('click', () => sendMessage({ command: 'copyFilePath', repo: this.currentRepo, filePath: filePath, absolute: false }));
		document.getElementById('fileHistoryOpen')!.addEventListener('click', () => {
			const latest = this.loadedCommits.find((commit) => commit.hash !== UNCOMMITTED);
			runAction({ command: 'openFile', repo: this.currentRepo, hash: typeof latest !== 'undefined' ? latest.hash : (this.commitHead || ''), filePath: filePath }, t('Opening File'));
		});
		document.getElementById('fileHistoryExit')!.addEventListener('click', () => this.setFileHistory(null));
		document.querySelectorAll<HTMLElement>('.fileHistoryBranchesOption').forEach((optionElem) => optionElem.addEventListener('click', () => {
			if (optionElem.classList.contains(CLASS_ACTIVE) || optionElem.classList.contains(CLASS_DISABLED)) return;
			this.currentBranches = optionElem.dataset.value === 'current' && this.gitBranchHead !== null ? [this.gitBranchHead] : [SHOW_ALL_BRANCHES];
			this.branchDropdown.setOptions(this.getBranchOptions(true), this.currentBranches);
			this.maxCommits = this.config.initialLoadCommits;
			this.saveState();
			this.clearCommits();
			this.requestLoadRepoInfoAndCommits(true, true);
		}));
	}

	/**
	 * Get the issues linked to by a commit message, according to the repository's Issue Linking configuration.
	 * @param message The commit message.
	 * @returns The label & URL of each issue.
	 */
	private getIssueLinks(message: string) {
		const config = this.gitRepos[this.currentRepo].issueLinkingConfig || globalState.issueLinkingConfig;
		const links: { label: string, url: string }[] = [];
		if (config === null) return links;
		let regex: RegExp;
		try {
			regex = new RegExp(config.issue, 'gu');
		} catch (_) {
			return links;
		}
		let match: RegExpExecArray | null;
		while ((match = regex.exec(message)) !== null) {
			if (match[0].length === 0) {
				regex.lastIndex++;
				continue;
			}
			const groups = match;
			if (!links.some((link) => link.label === groups[0])) {
				links.push({ label: groups[0], url: config.url.replace(/\$([1-9])/g, (_, n) => groups[parseInt(n)] || '') });
			}
		}
		return links;
	}

	/**
	 * Get the branches (on the loaded commits) that contain a commit.
	 * @param index The index of the commit.
	 * @returns The name, colour (of its branch on the graph) & whether it's a remote branch, of each branch.
	 */
	private getBranchesContainingCommit(index: number) {
		const colours = this.config.graph.colours, vertexColours = this.graph.getVertexColours();
		const reachable: { [hash: string]: boolean } = {}, local: { name: string, remote: boolean, colour: string }[] = [], remote: { name: string, remote: boolean, colour: string }[] = [];
		for (let i = index; i >= 0; i--) {
			const commit = this.commits[i];
			if (i !== index && !commit.parents.some((parent) => reachable[parent])) continue;
			reachable[commit.hash] = true;
			const colour = colours[(vertexColours[i] >= 0 ? vertexColours[i] : 0) % colours.length];
			commit.heads.forEach((name) => local.push({ name: name, remote: false, colour: colour }));
			commit.remotes.forEach((ref) => remote.push({ name: ref.name, remote: true, colour: colour }));
		}
		return local.concat(remote).slice(0, 12);
	}

	/**
	 * Get the URL of a commit on the web page of the repository's remote (origin, or its first remote), for GitHub, GitLab, Bitbucket, Gitea & similar hosts.
	 * @param hash The hash of the commit.
	 * @returns The URL, or NULL if the remote's URL isn't known.
	 */
	private getRemoteCommitUrl(hash: string) {
		if (this.gitConfig === null) return null;
		const remote = this.gitConfig.remotes.find((remote) => remote.name === 'origin' && remote.url !== null) || this.gitConfig.remotes.find((remote) => remote.url !== null);
		if (typeof remote === 'undefined' || remote.url === null) return null;
		const url = remote.url.trim();
		let match: RegExpMatchArray | null, webUrl: string;
		if ((match = url.match(/^(https?):\/\/(?:[^@\/]+@)?(.+?)(?:\.git)?\/?$/)) !== null) {
			webUrl = match[1] + '://' + match[2];
		} else if ((match = url.match(/^ssh:\/\/(?:[^@\/]+@)?([^:\/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/)) !== null) {
			webUrl = 'https://' + match[1] + '/' + match[2];
		} else if ((match = url.match(/^[^@\s\/]+@([^:\s]+):(.+?)(?:\.git)?\/?$/)) !== null) {
			webUrl = 'https://' + match[1] + '/' + match[2];
		} else {
			return null;
		}
		return webUrl + (/bitbucket/i.test(webUrl) ? '/commits/' : '/commit/') + hash;
	}

	/**
	 * Add the event listeners to the header & summary of the Commit Details View docked to the right.
	 */
	private makeCdvHeaderInteractive() {
		const expandedCommit = this.expandedCommit;
		if (expandedCommit === null) return;
		const navigate = (offset: number) => {
			if (this.expandedCommit === null || this.expandedCommit.compareWithHash !== null) return;
			const elem = findCommitElemWithId(getCommitElems(), this.commitLookup[this.expandedCommit.commitHash] + offset);
			if (elem !== null) this.loadCommitDetails(elem);
		};
		const prevElem = document.getElementById('cdvPrev'), nextElem = document.getElementById('cdvNext');
		if (prevElem !== null) prevElem.addEventListener('click', () => navigate(-1));
		if (nextElem !== null) nextElem.addEventListener('click', () => navigate(1));

		const copyHashElem = document.getElementById('cdvCopyHash');
		if (copyHashElem !== null) copyHashElem.addEventListener('click', () => sendMessage({ command: 'copyToClipboard', type: t('Commit Hash'), data: expandedCommit.commitHash }));
		const openOnRemoteElem = document.getElementById('cdvOpenOnRemote');
		if (openOnRemoteElem !== null) openOnRemoteElem.addEventListener('click', () => {
			const url = this.getRemoteCommitUrl(expandedCommit.commitHash);
			if (url !== null) sendMessage({ command: 'openExternalUrl', url: url });
		});
		const compareElem = document.getElementById('cdvCompare');
		if (compareElem !== null) compareElem.addEventListener('click', () => {
			this.cdvComparePending = !this.cdvComparePending;
			alterClass(compareElem, CLASS_ACTIVE, this.cdvComparePending);
			compareElem.innerHTML = SVG_ICONS.compare + (this.cdvComparePending ? t('Click on a commit to compare with') : t('Compare with…'));
		});

		addListenerToClass('cdvTab', 'click', (e) => {
			const tab = (<HTMLElement>(<Element>e.target).closest('.cdvTab')!).dataset.tab;
			document.querySelectorAll<HTMLElement>('.cdvTab').forEach((elem) => alterClass(elem, CLASS_ACTIVE, elem.dataset.tab === tab));
			const fileViewElem = document.getElementById('cdvFileView'), messageViewElem = document.getElementById('cdvMessageView');
			if (fileViewElem !== null) alterClass(fileViewElem, 'hidden', tab !== 'files');
			if (messageViewElem !== null) alterClass(messageViewElem, 'hidden', tab !== 'message');
		});
	}

	/**
	 * Render the buttons of the most common actions (and a button that opens all of the actions) for the commit shown in the Commit Details View.
	 */
	private renderCdvActions() {
		const expandedCommit = this.expandedCommit, actionsElem = document.getElementById('cdvActions');
		if (expandedCommit === null || expandedCommit.commitElem === null || actionsElem === null) return;
		const commit = this.commits[this.commitLookup[expandedCommit.commitHash]];
		if (typeof commit === 'undefined') return;

		const target: ContextMenuTarget & DialogTarget & CommitTarget = {
			type: TargetType.Commit,
			hash: commit.hash,
			index: parseInt(expandedCommit.commitElem.dataset.id!),
			elem: expandedCommit.commitElem
		};
		let actions: ContextMenuActions, primary: ContextMenuAction[];
		if (commit.hash === UNCOMMITTED) {
			actions = this.getUncommittedChangesContextMenuActions(target);
			primary = actions.reduce<ContextMenuAction[]>((all, group) => all.concat(group), []);
		} else if (commit.stash !== null) {
			target.ref = commit.stash.selector;
			actions = this.getStashContextMenuActions(<RefTarget>target);
			primary = actions.reduce<ContextMenuAction[]>((all, group) => all.concat(group), []);
		} else {
			actions = this.getCommitContextMenuActions(target);
			primary = [actions[1][0], actions[0][1], actions[1][1]]; // Checkout, Create Branch & Cherry Pick
		}
		primary = primary.filter((action) => action.visible).slice(0, 3);

		actionsElem.innerHTML = primary.map((action, i) => '<button type="button" class="cdvActionBtn' + (i === 0 ? ' primary' : '') + '" data-index="' + i + '" tabindex="-1">' + action.title + '</button>').join('')
			+ '<button type="button" id="cdvMoreActions" class="cdvActionBtn" title="' + t('More Actions') + '" tabindex="-1">&#183;&#183;&#183;</button>';
		actionsElem.querySelectorAll('.cdvActionBtn[data-index]').forEach((elem) => {
			elem.addEventListener('click', () => primary[parseInt((<HTMLElement>elem).dataset.index!)].onClick());
		});
		document.getElementById('cdvMoreActions')!.addEventListener('click', (e) => {
			handledEvent(e); // Don't let the click propagate to the document, which closes context menus
			contextMenu.show(actions, false, target, <MouseEvent>e, this.isCdvDocked() ? document.body : this.viewElem);
		});
	}

	private setCdvHeight(elem: HTMLElement, isDocked: boolean) {
		if (isDocked && this.isCdvDockedRight()) {
			const width = this.getCdvWidth(), widthPx = width + 'px';
			elem.style.width = widthPx;
			this.viewElem.style.right = widthPx;
			document.body.classList.add(CLASS_CDV_DOCKED_RIGHT);
			document.body.style.setProperty('--git-graph-cdvWidth', widthPx);
			return;
		}

		let height = this.gitRepos[this.currentRepo].cdvHeight, windowHeight = window.innerHeight;
		if (height > windowHeight - 40) {
			height = Math.max(windowHeight - 40, 100);
			if (height !== this.gitRepos[this.currentRepo].cdvHeight) {
				this.gitRepos[this.currentRepo].cdvHeight = height;
				this.saveRepoState();
			}
		}

		let heightPx = height + 'px';
		elem.style.height = heightPx;
		if (isDocked) this.viewElem.style.bottom = heightPx;
	}

	private setCdvDivider() {
		let percent = (this.gitRepos[this.currentRepo].cdvDivider * 100).toFixed(2) + '%';
		let summaryElem = document.getElementById('cdvSummary'), dividerElem = document.getElementById('cdvDivider'), filesElem = document.getElementById('cdvFiles');
		if (this.isCdvDocked() && this.isCdvDockedRight()) {
			// The summary is above the files
			if (summaryElem !== null) summaryElem.style.height = percent;
			if (dividerElem !== null) dividerElem.style.top = percent;
			if (filesElem !== null) filesElem.style.top = percent;
		} else {
			if (summaryElem !== null) summaryElem.style.width = percent;
			if (dividerElem !== null) dividerElem.style.left = percent;
			if (filesElem !== null) filesElem.style.left = percent;
		}
	}

	/**
	 * Get the width of the Commit Details View when it's docked to the right, limited to the width of the Webview.
	 * @returns The width (in pixels).
	 */
	private getCdvWidth() {
		const maxWidth = Math.max(window.innerWidth - 240, CDV_MIN_WIDTH);
		return Math.min(Math.max(this.gitRepos[this.currentRepo].cdvWidth || CDV_DEFAULT_WIDTH, CDV_MIN_WIDTH), maxWidth);
	}

	private makeCdvResizable() {
		let prevY = -1, prevX = -1;

		const processResizingCdvWidth: EventListener = (e) => {
			if (prevX < 0) return;
			const delta = (<MouseEvent>e).pageX - prevX;
			prevX = (<MouseEvent>e).pageX;
			const width = Math.min(Math.max(this.getCdvWidth() - delta, CDV_MIN_WIDTH), Math.max(window.innerWidth - 240, CDV_MIN_WIDTH));
			if (this.gitRepos[this.currentRepo].cdvWidth !== width) {
				this.gitRepos[this.currentRepo].cdvWidth = width;
				const elem = document.getElementById('cdv');
				if (elem !== null) this.setCdvHeight(elem, true);
			}
		};
		const stopResizingCdvWidth: EventListener = (e) => {
			if (prevX < 0) return;
			processResizingCdvWidth(e);
			this.saveRepoState();
			prevX = -1;
			eventOverlay.remove();
		};

		const processResizingCdvHeight: EventListener = (e) => {
			if (prevY < 0) return;
			let delta = (<MouseEvent>e).pageY - prevY, isDocked = this.isCdvDocked(), windowHeight = window.innerHeight;
			prevY = (<MouseEvent>e).pageY;
			let height = this.gitRepos[this.currentRepo].cdvHeight + (isDocked ? -delta : delta);
			if (height < 100) height = 100;
			else if (height > 600) height = 600;
			if (height > windowHeight - 40) height = Math.max(windowHeight - 40, 100);

			if (this.gitRepos[this.currentRepo].cdvHeight !== height) {
				this.gitRepos[this.currentRepo].cdvHeight = height;
				let elem = document.getElementById('cdv');
				if (elem !== null) this.setCdvHeight(elem, isDocked);
				if (!isDocked) this.renderGraph();
			}
		};
		const stopResizingCdvHeight: EventListener = (e) => {
			if (prevY < 0) return;
			processResizingCdvHeight(e);
			this.saveRepoState();
			prevY = -1;
			eventOverlay.remove();
		};

		addListenerToClass('cdvHeightResize', 'mousedown', (e) => {
			if (this.isCdvDocked() && this.isCdvDockedRight()) {
				prevX = (<MouseEvent>e).pageX;
				eventOverlay.create('colResize', processResizingCdvWidth, stopResizingCdvWidth);
			} else {
				prevY = (<MouseEvent>e).pageY;
				eventOverlay.create('rowResize', processResizingCdvHeight, stopResizingCdvHeight);
			}
		});
	}

	private makeCdvDividerDraggable() {
		let minX = -1, width = -1, vertical = false;

		const processDraggingCdvDivider: EventListener = (e) => {
			if (minX < 0) return;
			let percent = ((vertical ? (<MouseEvent>e).clientY : (<MouseEvent>e).clientX) - minX) / width;
			if (percent < 0.2) percent = 0.2;
			else if (percent > 0.8) percent = 0.8;

			if (this.gitRepos[this.currentRepo].cdvDivider !== percent) {
				this.gitRepos[this.currentRepo].cdvDivider = percent;
				this.setCdvDivider();
			}
		};
		const stopDraggingCdvDivider: EventListener = (e) => {
			if (minX < 0) return;
			processDraggingCdvDivider(e);
			this.saveRepoState();
			minX = -1;
			eventOverlay.remove();
		};

		document.getElementById('cdvDivider')!.addEventListener('mousedown', () => {
			const contentElem = document.getElementById('cdvContent');
			if (contentElem === null) return;

			const bounds = contentElem.getBoundingClientRect();
			vertical = this.isCdvDocked() && this.isCdvDockedRight();
			minX = vertical ? bounds.top : bounds.left;
			width = vertical ? bounds.height : bounds.width;
			eventOverlay.create(vertical ? 'rowResize' : 'colResize', processDraggingCdvDivider, stopDraggingCdvDivider);
		});
	}

	/**
	 * Updates the state of a file in the Commit Details View.
	 * @param file The file that was affected.
	 * @param fileElem The HTML Element of the file.
	 * @param isReviewed TRUE/FALSE => Set the files reviewed state accordingly, NULL => Don't update the files reviewed state.
	 * @param fileWasViewed Was the file viewed - if so, set it to be the last viewed file.
	 */
	private cdvUpdateFileState(file: GG.GitFileChange, fileElem: HTMLElement, isReviewed: boolean | null, fileWasViewed: boolean) {
		const expandedCommit = this.expandedCommit, filesElem = getCdvFileViewElem(), filePath = file.newFilePath;
		if (expandedCommit === null || expandedCommit.fileTree === null || filesElem === null) return;

		if (fileWasViewed) {
			expandedCommit.lastViewedFile = filePath;
			let lastViewedElem = document.getElementById('cdvLastFileViewed');
			if (lastViewedElem !== null) lastViewedElem.remove();
			lastViewedElem = document.createElement('span');
			lastViewedElem.id = 'cdvLastFileViewed';
			lastViewedElem.title = t('Last File Viewed');
			lastViewedElem.innerHTML = SVG_ICONS.eyeOpen;
			insertBeforeFirstChildWithClass(lastViewedElem, fileElem, 'fileTreeFileAction');
		}

		if (expandedCommit.codeReview !== null) {
			if (isReviewed !== null) {
				if (isReviewed) {
					expandedCommit.codeReview.remainingFiles = expandedCommit.codeReview.remainingFiles.filter((path: string) => path !== filePath);
				} else {
					expandedCommit.codeReview.remainingFiles.push(filePath);
				}

				alterFileTreeFileReviewed(expandedCommit.fileTree, filePath, isReviewed);
				updateFileTreeHtmlFileReviewed(filesElem, expandedCommit.fileTree, filePath);
			}

			sendMessage({
				command: 'updateCodeReview',
				repo: this.currentRepo,
				id: expandedCommit.codeReview.id,
				remainingFiles: expandedCommit.codeReview.remainingFiles,
				lastViewedFile: expandedCommit.lastViewedFile
			});

			if (expandedCommit.codeReview.remainingFiles.length === 0) {
				expandedCommit.codeReview = null;
				this.renderCodeReviewBtn();
			}
		}

		this.saveState();
	}

	private isCdvDocked() {
		return this.config.commitDetailsView.location !== GG.CommitDetailsViewLocation.Inline;
	}

	private isCdvDockedRight() {
		return this.config.commitDetailsView.location === GG.CommitDetailsViewLocation.DockedToRight;
	}

	public isCdvOpen(commitHash: string, compareWithHash: string | null) {
		return this.expandedCommit !== null && this.expandedCommit.commitHash === commitHash && this.expandedCommit.compareWithHash === compareWithHash;
	}

	private getCommitOrder(hash1: string, hash2: string) {
		if (this.commitLookup[hash1] > this.commitLookup[hash2]) {
			return { from: hash1, to: hash2 };
		} else {
			return { from: hash2, to: hash1 };
		}
	}

	private getFileViewType() {
		return this.gitRepos[this.currentRepo].fileViewType === GG.FileViewType.Default
			? this.config.commitDetailsView.fileViewType
			: this.gitRepos[this.currentRepo].fileViewType;
	}

	private setFileViewType(type: GG.FileViewType) {
		this.gitRepos[this.currentRepo].fileViewType = type;
		this.saveRepoState();
	}

	/**
	 * Re-render the file view of the Commit Details View (if it's open), e.g. after the file icon theme has changed.
	 */
	public refreshCdvFileView() {
		if (this.expandedCommit !== null && this.expandedCommit.fileTree !== null && !this.expandedCommit.loading) {
			this.changeFileViewType(this.getFileViewType());
		}
	}

	private changeFileViewType(type: GG.FileViewType) {
		const expandedCommit = this.expandedCommit, filesElem = getCdvFileViewElem();
		if (expandedCommit === null || expandedCommit.fileTree === null || expandedCommit.fileChanges === null || filesElem === null) return;
		GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
		this.setFileViewType(type);
		const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
		filesElem.innerHTML = generateFileViewHtml(expandedCommit.fileTree, expandedCommit.fileChanges, expandedCommit.lastViewedFile, expandedCommit.contextMenuOpen.fileView, type, commitOrder.to === UNCOMMITTED);
		this.makeCdvFileViewInteractive();
		this.renderCdvFileViewTypeBtns();
	}

	private makeCdvFileViewInteractive() {
		const getFileElemOfEventTarget = (target: EventTarget) => <HTMLElement>(<Element>target).closest('.fileTreeFileRecord');
		const getFileOfFileElem = (fileChanges: ReadonlyArray<GG.GitFileChange>, fileElem: HTMLElement) => fileChanges[parseInt(fileElem.dataset.index!)];

		const getCommitHashForFile = (file: GG.GitFileChange, expandedCommit: ExpandedCommit) => {
			const commit = this.commits[this.commitLookup[expandedCommit.commitHash]];
			if (expandedCommit.compareWithHash !== null) {
				return this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash).to;
			} else if (commit.stash !== null && file.type === GG.GitFileStatus.Untracked) {
				return commit.stash.untrackedFilesHash!;
			} else {
				return expandedCommit.commitHash;
			}
		};

		const triggerViewFileDiff = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null) return;

			let commit = this.commits[this.commitLookup[expandedCommit.commitHash]], fromHash: string, toHash: string, fileStatus = file.type;
			if (expandedCommit.compareWithHash !== null) {
				// Commit Comparison
				const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash);
				fromHash = commitOrder.from;
				toHash = commitOrder.to;
			} else if (commit.stash !== null) {
				// Stash Commit
				if (fileStatus === GG.GitFileStatus.Untracked) {
					fromHash = commit.stash.untrackedFilesHash!;
					toHash = commit.stash.untrackedFilesHash!;
					fileStatus = GG.GitFileStatus.Added;
				} else {
					fromHash = commit.stash.baseHash;
					toHash = expandedCommit.commitHash;
				}
			} else {
				// Single Commit
				fromHash = expandedCommit.commitHash;
				toHash = expandedCommit.commitHash;
			}

			this.cdvUpdateFileState(file, fileElem, true, true);
			sendMessage({
				command: 'viewDiff',
				repo: this.currentRepo,
				fromHash: fromHash,
				toHash: toHash,
				oldFilePath: file.oldFilePath,
				newFilePath: file.newFilePath,
				type: fileStatus
			});
		};

		const triggerCopyFilePath = (file: GG.GitFileChange, absolute: boolean) => {
			sendMessage({ command: 'copyFilePath', repo: this.currentRepo, filePath: file.newFilePath, absolute: absolute });
		};

		const triggerResetFileToRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null) return;

			const commitHash = getCommitHashForFile(file, expandedCommit);
			dialog.showConfirmation(t('Are you sure you want to reset <b><i>{0}</i></b> to it\'s state at commit <b><i>{1}</i></b>? Any uncommitted changes made to this file will be overwritten.', escapeHtml(file.newFilePath), abbrevCommit(commitHash)), t('Yes, reset file'), () => {
				runAction({ command: 'resetFileToRevision', repo: this.currentRepo, commitHash: commitHash, filePath: file.newFilePath }, t('Resetting file'));
			}, {
				type: TargetType.CommitDetailsView,
				hash: commitHash,
				elem: fileElem
			});
		};

		const triggerViewFileAtRevision = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null) return;

			this.cdvUpdateFileState(file, fileElem, true, true);
			sendMessage({ command: 'viewFileAtRevision', repo: this.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
		};

		const triggerViewFileDiffWithWorkingFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null) return;

			this.cdvUpdateFileState(file, fileElem, null, true);
			sendMessage({ command: 'viewDiffWithWorkingFile', repo: this.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
		};

		const triggerOpenFile = (file: GG.GitFileChange, fileElem: HTMLElement) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null) return;

			this.cdvUpdateFileState(file, fileElem, true, true);
			sendMessage({ command: 'openFile', repo: this.currentRepo, hash: getCommitHashForFile(file, expandedCommit), filePath: file.newFilePath });
		};

		addListenerToClass('fileTreeFolder', 'click', (e) => {
			let expandedCommit = this.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileTree === null || e.target === null) return;

			let sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFolder');
			let parent = sourceElem.parentElement!;
			parent.classList.toggle('closed');
			let isOpen = !parent.classList.contains('closed');
			const folderName = sourceElem.querySelector('.gitFolderName')!.textContent!;
			parent.children[0].children[0].innerHTML = fileIcons.getFolderIcon(folderName.substring(folderName.lastIndexOf(' / ') + 1).trim(), isOpen);
			parent.children[1].classList.toggle('hidden');
			alterFileTreeFolderOpen(expandedCommit.fileTree, decodeURIComponent(sourceElem.dataset.folderpath!), isOpen);
			this.saveState();
		});

		addListenerToClass('fileTreeRepo', 'click', (e) => {
			if (e.target === null) return;
			this.loadRepos(this.gitRepos, null, {
				repo: decodeURIComponent((<HTMLElement>(<Element>e.target).closest('.fileTreeRepo')).dataset.path!)
			});
		});

		addListenerToClass('fileTreeFile', 'click', (e) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const sourceElem = <HTMLElement>(<Element>e.target).closest('.fileTreeFile'), fileElem = getFileElemOfEventTarget(e.target);
			if (!sourceElem.classList.contains('gitDiffPossible')) return;
			triggerViewFileDiff(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
		});

		addListenerToClass('copyGitFile', 'click', (e) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const fileElem = getFileElemOfEventTarget(e.target);
			triggerCopyFilePath(getFileOfFileElem(expandedCommit.fileChanges, fileElem), true);
		});

		addListenerToClass('viewGitFileAtRevision', 'click', (e) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const fileElem = getFileElemOfEventTarget(e.target);
			triggerViewFileAtRevision(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
		});

		addListenerToClass('openGitFile', 'click', (e) => {
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;

			const fileElem = getFileElemOfEventTarget(e.target);
			triggerOpenFile(getFileOfFileElem(expandedCommit.fileChanges, fileElem), fileElem);
		});

		addListenerToClass('fileTreeFileRecord', 'contextmenu', (e: Event) => {
			handledEvent(e);
			const expandedCommit = this.expandedCommit;
			if (expandedCommit === null || expandedCommit.fileChanges === null || e.target === null) return;
			const fileElem = getFileElemOfEventTarget(e.target);
			const file = getFileOfFileElem(expandedCommit.fileChanges, fileElem);
			const commitOrder = this.getCommitOrder(expandedCommit.commitHash, expandedCommit.compareWithHash === null ? expandedCommit.commitHash : expandedCommit.compareWithHash);
			const isUncommitted = commitOrder.to === UNCOMMITTED;

			GitGraphView.closeCdvContextMenuIfOpen(expandedCommit);
			expandedCommit.contextMenuOpen.fileView = parseInt(fileElem.dataset.index!);

			const target: ContextMenuTarget & CommitTarget = {
				type: TargetType.CommitDetailsView,
				hash: expandedCommit.commitHash,
				index: this.commitLookup[expandedCommit.commitHash],
				elem: fileElem
			};
			const diffPossible = file.type === GG.GitFileStatus.Untracked || (file.additions !== null && file.deletions !== null);
			const fileExistsAtThisRevision = file.type !== GG.GitFileStatus.Deleted && !isUncommitted;
			const fileExistsAtThisRevisionAndDiffPossible = fileExistsAtThisRevision && diffPossible;
			const codeReviewInProgressAndNotReviewed = expandedCommit.codeReview !== null && expandedCommit.codeReview.remainingFiles.includes(file.newFilePath);
			const visibility = this.config.contextMenuActionsVisibility.commitDetailsViewFile;

			contextMenu.show([
				[
					{
						title: t('View Diff'),
						visible: visibility.viewDiff && diffPossible,
						onClick: () => triggerViewFileDiff(file, fileElem)
					},
					{
						title: t('View File at this Revision'),
						visible: visibility.viewFileAtThisRevision && fileExistsAtThisRevisionAndDiffPossible,
						onClick: () => triggerViewFileAtRevision(file, fileElem)
					},
					{
						title: t('View Diff with Working File'),
						visible: visibility.viewDiffWithWorkingFile && fileExistsAtThisRevisionAndDiffPossible,
						onClick: () => triggerViewFileDiffWithWorkingFile(file, fileElem)
					},
					{
						title: t('Open File'),
						visible: visibility.openFile && file.type !== GG.GitFileStatus.Deleted,
						onClick: () => triggerOpenFile(file, fileElem)
					},
					{
						title: t('View File History'),
						visible: file.type !== GG.GitFileStatus.Untracked && this.fileHistory !== file.newFilePath,
						onClick: () => this.setFileHistory(file.newFilePath)
					}
				],
				[
					{
						title: t('Mark as Reviewed'),
						visible: visibility.markAsReviewed && codeReviewInProgressAndNotReviewed,
						onClick: () => this.cdvUpdateFileState(file, fileElem, true, false)
					},
					{
						title: t('Mark as Not Reviewed'),
						visible: visibility.markAsNotReviewed && expandedCommit.codeReview !== null && !codeReviewInProgressAndNotReviewed,
						onClick: () => this.cdvUpdateFileState(file, fileElem, false, false)
					}
				],
				[
					{
						title: t('Reset File to this Revision') + ELLIPSIS,
						visible: visibility.resetFileToThisRevision && fileExistsAtThisRevision && expandedCommit.compareWithHash === null,
						onClick: () => triggerResetFileToRevision(file, fileElem)
					}
				],
				[
					{
						title: t('Copy Absolute File Path to Clipboard'),
						visible: visibility.copyAbsoluteFilePath,
						onClick: () => triggerCopyFilePath(file, true)
					},
					{
						title: t('Copy Relative File Path to Clipboard'),
						visible: visibility.copyRelativeFilePath,
						onClick: () => triggerCopyFilePath(file, false)
					}
				]
			], false, target, <MouseEvent>e, this.isCdvDocked() ? document.body : this.viewElem, () => {
				expandedCommit.contextMenuOpen.fileView = -1;
			});
		});
	}

	private renderCdvFileViewTypeBtns() {
		if (this.expandedCommit === null) return;
		let treeBtnElem = document.getElementById('cdvFileViewTypeTree'), listBtnElem = document.getElementById('cdvFileViewTypeList');
		if (treeBtnElem === null || listBtnElem === null) return;

		let listView = this.getFileViewType() === GG.FileViewType.List;
		alterClass(treeBtnElem, CLASS_ACTIVE, !listView);
		alterClass(listBtnElem, CLASS_ACTIVE, listView);
	}

	private renderCdvExternalDiffBtn() {
		if (this.expandedCommit === null) return;
		const externalDiffBtnElem = document.getElementById('cdvExternalDiff');
		if (externalDiffBtnElem === null) return;

		alterClass(externalDiffBtnElem, CLASS_ENABLED, this.gitConfig !== null && (this.gitConfig.diffTool !== null || this.gitConfig.guiDiffTool !== null));
		const toolName = this.gitConfig !== null
			? this.gitConfig.guiDiffTool !== null
				? this.gitConfig.guiDiffTool
				: this.gitConfig.diffTool
			: null;
		externalDiffBtnElem.title = (toolName !== null ? t('Open External Directory Diff with "{0}"', toolName) : t('Open External Directory Diff'));
	}

	private static closeCdvContextMenuIfOpen(expandedCommit: ExpandedCommit) {
		if (expandedCommit.contextMenuOpen.summary || expandedCommit.contextMenuOpen.fileView > -1) {
			expandedCommit.contextMenuOpen.summary = false;
			expandedCommit.contextMenuOpen.fileView = -1;
			contextMenu.close();
		}
	}


	/* Code Review */

	public startCodeReview(commitHash: string, compareWithHash: string | null, codeReview: GG.CodeReview) {
		if (this.expandedCommit === null || this.expandedCommit.commitHash !== commitHash || this.expandedCommit.compareWithHash !== compareWithHash) return;
		this.saveAndRenderCodeReview(codeReview);
	}

	public endCodeReview() {
		if (this.expandedCommit === null || this.expandedCommit.codeReview === null) return;
		this.saveAndRenderCodeReview(null);
	}

	private saveAndRenderCodeReview(codeReview: GG.CodeReview | null) {
		let filesElem = getCdvFileViewElem();
		if (this.expandedCommit === null || this.expandedCommit.fileTree === null || filesElem === null) return;

		this.expandedCommit.codeReview = codeReview;
		setFileTreeReviewed(this.expandedCommit.fileTree, codeReview === null);
		this.saveState();
		this.renderCodeReviewBtn();
		updateFileTreeHtml(filesElem, this.expandedCommit.fileTree);
	}

	private renderCodeReviewBtn() {
		if (this.expandedCommit === null) return;
		let btnElem = document.getElementById('cdvCodeReview');
		if (btnElem === null) return;

		let active = this.expandedCommit.codeReview !== null;
		alterClass(btnElem, CLASS_ACTIVE, active);
		btnElem.title = active ? t('End Code Review') : t('Start Code Review');
	}
}


/* Main */

const contextMenu = new ContextMenu(), dialog = new Dialog(), eventOverlay = new EventOverlay(), titleTooltip = new TitleTooltip(), fileIcons = new FileIcons();
let loaded = false;

window.addEventListener('load', () => {
	if (loaded) return;
	loaded = true;

	TextFormatter.registerCustomEmojiMappings(initialState.config.customEmojiShortcodeMappings);

	const viewElem = document.getElementById('view');
	if (viewElem === null) return;

	const gitGraph = new GitGraphView(viewElem, VSCODE_API.getState());
	const imageResizer = new ImageResizer();

	/* Command Processing */
	window.addEventListener('message', event => {
		const msg: GG.ResponseMessage = event.data;
		switch (msg.command) {
			case 'addRemote':
				refreshOrDisplayError(msg.error, t('Unable to Add Remote'), true);
				break;
			case 'addTag':
				if (msg.pushToRemote !== null && msg.errors.length === 2 && msg.errors[0] === null && isExtensionErrorInfo(msg.errors[1], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
					gitGraph.refresh(false);
					handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, [msg.pushToRemote], msg.commitHash, msg.errors[1]!);
				} else {
					refreshAndDisplayErrors(msg.errors, t('Unable to Add Tag'));
				}
				break;
			case 'applyStash':
				refreshOrDisplayError(msg.error, t('Unable to Apply Stash'));
				break;
			case 'branchFromStash':
				refreshOrDisplayError(msg.error, t('Unable to Create Branch from Stash'));
				break;
			case 'checkoutBranch':
				refreshAndDisplayErrors(msg.errors, t('Unable to Checkout Branch{0}', (msg.pullAfterwards !== null ? t(' & Pull Changes') : '')));
				break;
			case 'checkoutCommit':
				refreshOrDisplayError(msg.error, t('Unable to Checkout Commit'));
				break;
			case 'cherrypickCommit':
				refreshAndDisplayErrors(msg.errors, t('Unable to Cherry Pick Commit'));
				break;
			case 'cleanUntrackedFiles':
				refreshOrDisplayError(msg.error, t('Unable to Clean Untracked Files'));
				break;
			case 'commitDetails':
				if (msg.commitDetails !== null) {
					gitGraph.showCommitDetails(msg.commitDetails, gitGraph.createFileTree(msg.commitDetails.fileChanges, msg.codeReview), msg.avatar, msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
				} else {
					gitGraph.closeCommitDetails(true);
					dialog.showError(t('Unable to load Commit Details'), msg.error, null, null);
				}
				break;
			case 'compareCommits':
				if (msg.error === null) {
					gitGraph.showCommitComparison(msg.commitHash, msg.compareWithHash, msg.fileChanges, gitGraph.createFileTree(msg.fileChanges, msg.codeReview), msg.codeReview, msg.codeReview !== null ? msg.codeReview.lastViewedFile : null, msg.refresh);
				} else {
					gitGraph.closeCommitComparison(true);
					dialog.showError(t('Unable to load Commit Comparison'), msg.error, null, null);
				}
				break;
			case 'copyFilePath':
				finishOrDisplayError(msg.error, t('Unable to Copy File Path to Clipboard'));
				break;
			case 'copyToClipboard':
				finishOrDisplayError(msg.error, t('Unable to Copy {0} to Clipboard', msg.type));
				break;
			case 'createArchive':
				finishOrDisplayError(msg.error, t('Unable to Create Archive'), true);
				break;
			case 'createBranch':
				refreshAndDisplayErrors(msg.errors, t('Unable to Create Branch'));
				break;
			case 'createPullRequest':
				finishOrDisplayErrors(msg.errors, t('Unable to Create Pull Request'), () => {
					if (msg.push) {
						gitGraph.refresh(false);
					}
				}, true);
				break;
			case 'deleteBranch':
				handleResponseDeleteBranch(msg);
				break;
			case 'deleteRemote':
				refreshOrDisplayError(msg.error, t('Unable to Delete Remote'), true);
				break;
			case 'deleteRemoteBranch':
				refreshOrDisplayError(msg.error, t('Unable to Delete Remote Branch'));
				break;
			case 'deleteTag':
				refreshOrDisplayError(msg.error, t('Unable to Delete Tag'));
				break;
			case 'deleteUserDetails':
				finishOrDisplayErrors(msg.errors, t('Unable to Remove Git User Details'), () => gitGraph.requestLoadConfig(), true);
				break;
			case 'dropCommit':
				refreshOrDisplayError(msg.error, t('Unable to Drop Commit'));
				break;
			case 'dropStash':
				refreshOrDisplayError(msg.error, t('Unable to Drop Stash'));
				break;
			case 'editRemote':
				refreshOrDisplayError(msg.error, t('Unable to Save Changes to Remote'), true);
				break;
			case 'editUserDetails':
				finishOrDisplayErrors(msg.errors, t('Unable to Save Git User Details'), () => gitGraph.requestLoadConfig(), true);
				break;
			case 'exportRepoConfig':
				refreshOrDisplayError(msg.error, t('Unable to Export Repository Configuration'));
				break;
			case 'fetch':
				refreshOrDisplayError(msg.error, t('Unable to Fetch from Remote(s)'));
				break;
			case 'fetchAvatar':
				imageResizer.resize(msg.image, (resizedImage) => {
					gitGraph.loadAvatar(msg.email, resizedImage);
				});
				break;
			case 'fetchIntoLocalBranch':
				refreshOrDisplayError(msg.error, t('Unable to Fetch into Local Branch'));
				break;
			case 'loadCommits':
				gitGraph.processLoadCommitsResponse(msg);
				break;
			case 'loadConfig':
				gitGraph.processLoadConfig(msg);
				break;
			case 'loadRepoInfo':
				gitGraph.processLoadRepoInfoResponse(msg);
				break;
			case 'loadStashStats':
				gitGraph.processLoadStashStatsResponse(msg);
				break;
			case 'loadFileDiff':
				gitGraph.processLoadFileDiffResponse(msg);
				break;
			case 'loadCommitStats':
				gitGraph.processLoadCommitStatsResponse(msg);
				break;
			case 'loadFileIconTheme':
				fileIcons.setTheme(msg.theme);
				gitGraph.refreshCdvFileView();
				break;
			case 'loadRepos':
				gitGraph.loadRepos(msg.repos, msg.lastActiveRepo, msg.loadViewTo);
				break;
			case 'searchCommits':
				gitGraph.processSearchCommitsResponse(msg);
				break;
			case 'merge':
				refreshOrDisplayError(msg.error, t('Unable to Merge {0}', t(msg.actionOn)));
				break;
			case 'openExtensionSettings':
				finishOrDisplayError(msg.error, t('Unable to Open Extension Settings'));
				break;
			case 'updateExtensionSetting':
				finishOrDisplayError(msg.error, t('Unable to Update Extension Setting'));
				break;
			case 'openExternalDirDiff':
				finishOrDisplayError(msg.error, t('Unable to Open External Directory Diff'), true);
				break;
			case 'openExternalUrl':
				finishOrDisplayError(msg.error, t('Unable to Open External URL'));
				break;
			case 'openFile':
				finishOrDisplayError(msg.error, t('Unable to Open File'));
				break;
			case 'openTerminal':
				finishOrDisplayError(msg.error, t('Unable to Open Terminal'), true);
				break;
			case 'popStash':
				refreshOrDisplayError(msg.error, t('Unable to Pop Stash'));
				break;
			case 'pruneRemote':
				refreshOrDisplayError(msg.error, t('Unable to Prune Remote'));
				break;
			case 'pullBranch':
				refreshOrDisplayError(msg.error, t('Unable to Pull Branch'));
				break;
			case 'pushBranch':
				refreshAndDisplayErrors(msg.errors, t('Unable to Push Branch'), msg.willUpdateBranchConfig);
				break;
			case 'pushStash':
				refreshOrDisplayError(msg.error, t('Unable to Stash Uncommitted Changes'));
				break;
			case 'pushTag':
				if (msg.errors.length === 1 && isExtensionErrorInfo(msg.errors[0], GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote)) {
					handleResponsePushTagCommitNotOnRemote(msg.repo, msg.tagName, msg.remotes, msg.commitHash, msg.errors[0]!);
				} else {
					refreshAndDisplayErrors(msg.errors, t('Unable to Push Tag'));
				}
				break;
			case 'rebase':
				if (msg.error === null) {
					if (msg.interactive) {
						dialog.closeActionRunning();
					} else {
						gitGraph.refresh(false);
					}
				} else {
					dialog.showError(t('Unable to Rebase current branch on {0}', t(msg.actionOn)), msg.error, null, null);
				}
				break;
			case 'refresh':
				gitGraph.refresh(false);
				break;
			case 'renameBranch':
				refreshOrDisplayError(msg.error, t('Unable to Rename Branch'));
				break;
			case 'resetFileToRevision':
				refreshOrDisplayError(msg.error, t('Unable to Reset File to Revision'));
				break;
			case 'resetToCommit':
				refreshOrDisplayError(msg.error, t('Unable to Reset to Commit'));
				break;
			case 'revertCommit':
				refreshOrDisplayError(msg.error, t('Unable to Revert Commit'));
				break;
			case 'setGlobalViewState':
				finishOrDisplayError(msg.error, t('Unable to save the Global View State'));
				break;
			case 'setWorkspaceViewState':
				finishOrDisplayError(msg.error, t('Unable to save the Workspace View State'));
				break;
			case 'startCodeReview':
				if (msg.error === null) {
					gitGraph.startCodeReview(msg.commitHash, msg.compareWithHash, msg.codeReview);
				} else {
					dialog.showError(t('Unable to Start Code Review'), msg.error, null, null);
				}
				break;
			case 'tagDetails':
				if (msg.details !== null) {
					gitGraph.renderTagDetails(msg.tagName, msg.commitHash, msg.details);
				} else {
					dialog.showError(t('Unable to retrieve Tag Details'), msg.error, null, null);
				}
				break;
			case 'updateCodeReview':
				if (msg.error !== null) {
					dialog.showError(t('Unable to update Code Review'), msg.error, null, null);
				}
				break;
			case 'viewDiff':
				finishOrDisplayError(msg.error, t('Unable to View Diff'));
				break;
			case 'viewDiffWithWorkingFile':
				finishOrDisplayError(msg.error, t('Unable to View Diff with Working File'));
				break;
			case 'viewFileAtRevision':
				finishOrDisplayError(msg.error, t('Unable to View File at Revision'));
				break;
			case 'viewScm':
				finishOrDisplayError(msg.error, t('Unable to open the Source Control View'));
				break;
		}
	});

	function handleResponseDeleteBranch(msg: GG.ResponseDeleteBranch) {
		if (msg.errors.length > 0 && msg.errors[0] !== null && msg.errors[0].includes('git branch -D')) {
			dialog.showConfirmation(t('The branch <b><i>{0}</i></b> is not fully merged. Would you like to force delete it?', escapeHtml(msg.branchName)), t('Yes, force delete branch'), () => {
				runAction({ command: 'deleteBranch', repo: msg.repo, branchName: msg.branchName, forceDelete: true, deleteOnRemotes: msg.deleteOnRemotes }, t('Deleting Branch'));
			}, { type: TargetType.Repo });
		} else {
			refreshAndDisplayErrors(msg.errors, t('Unable to Delete Branch'));
		}
	}

	function handleResponsePushTagCommitNotOnRemote(repo: string, tagName: string, remotes: string[], commitHash: string, error: string) {
		const remotesNotContainingCommit: string[] = parseExtensionErrorInfo(error, GG.ErrorInfoExtensionPrefix.PushTagCommitNotOnRemote);

		const html = '<span class="dialogAlert">' + SVG_ICONS.alert + (remotesNotContainingCommit.length > 1 ? t('Warning: Commit is not on Remotes') : t('Warning: Commit is not on Remote')) + ' </span><br>' +
			'<span class="messageContent">' +
			'<p style="margin:0 0 6px 0;">' + t('The tag <b><i>{0}</i></b> is on a commit that isn\'t on any known branch on the remote{1} {2}.', escapeHtml(tagName), (remotesNotContainingCommit.length > 1 ? 's' : ''), formatCommaSeparatedList(remotesNotContainingCommit.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>'))) + '</p>' +
			'<p style="margin:0;">' + t('Would you like to proceed to push the tag to the remote{0} {1} anyway?', (remotes.length > 1 ? 's' : ''), formatCommaSeparatedList(remotes.map((remote) => '<b><i>' + escapeHtml(remote) + '</i></b>'))) + '</p>' +
			'</span>';

		dialog.showForm(html, [{ type: DialogInputType.Checkbox, name: t('Always Proceed'), value: false }], t('Proceed to Push'), (values) => {
			if (<boolean>values[0]) {
				updateGlobalViewState('pushTagSkipRemoteCheck', true);
			}
			runAction({
				command: 'pushTag',
				repo: repo,
				tagName: tagName,
				remotes: remotes,
				commitHash: commitHash,
				skipRemoteCheck: true
			}, t('Pushing Tag'));
		}, { type: TargetType.Repo }, t('Cancel'), null);
	}

	function refreshOrDisplayError(error: GG.ErrorInfo, errorMessage: string, configChanges: boolean = false) {
		if (error === null) {
			gitGraph.refresh(false, configChanges);
		} else {
			dialog.showError(errorMessage, error, null, null);
		}
	}

	function refreshAndDisplayErrors(errors: GG.ErrorInfo[], errorMessage: string, configChanges: boolean = false) {
		const reducedErrors = reduceErrorInfos(errors);
		if (reducedErrors.error !== null) {
			dialog.showError(errorMessage, reducedErrors.error, null, null);
		}
		if (reducedErrors.partialOrCompleteSuccess) {
			gitGraph.refresh(false, configChanges);
		} else if (configChanges) {
			gitGraph.requestLoadConfig();
		}
	}

	function finishOrDisplayError(error: GG.ErrorInfo, errorMessage: string, dismissActionRunning: boolean = false) {
		if (error !== null) {
			dialog.showError(errorMessage, error, null, null);
		} else if (dismissActionRunning) {
			dialog.closeActionRunning();
		}
	}

	function finishOrDisplayErrors(errors: GG.ErrorInfo[], errorMessage: string, partialOrCompleteSuccessCallback: () => void, dismissActionRunning: boolean = false) {
		const reducedErrors = reduceErrorInfos(errors);
		finishOrDisplayError(reducedErrors.error, errorMessage, dismissActionRunning);
		if (reducedErrors.partialOrCompleteSuccess) {
			partialOrCompleteSuccessCallback();
		}
	}

	function reduceErrorInfos(errors: GG.ErrorInfo[]) {
		let error: GG.ErrorInfo = null, partialOrCompleteSuccess = false;
		for (let i = 0; i < errors.length; i++) {
			if (errors[i] !== null) {
				error = error !== null ? error + '\n\n' + errors[i] : errors[i];
			} else {
				partialOrCompleteSuccess = true;
			}
		}

		return {
			error: error,
			partialOrCompleteSuccess: partialOrCompleteSuccess
		};
	}

	/**
	 * Checks whether the given ErrorInfo has an ErrorInfoExtensionPrefix.
	 * @param error The ErrorInfo to check.
	 * @param prefix The ErrorInfoExtensionPrefix to test.
	 * @returns TRUE => ErrorInfo has the ErrorInfoExtensionPrefix, FALSE => ErrorInfo doesn\'t have the ErrorInfoExtensionPrefix
	 */
	function isExtensionErrorInfo(error: GG.ErrorInfo, prefix: GG.ErrorInfoExtensionPrefix) {
		return error !== null && error.startsWith(prefix);
	}

	/**
	 * Parses the JSON data from an ErrorInfo prefixed by the provided ErrorInfoExtensionPrefix.
	 * @param error The ErrorInfo to parse.
	 * @param prefix The ErrorInfoExtensionPrefix used by `error`.
	 * @returns The parsed JSON data.
	 */
	function parseExtensionErrorInfo(error: string, prefix: GG.ErrorInfoExtensionPrefix) {
		return JSON.parse(error.substring(prefix.length));
	}
});


/* File Tree Methods (for the Commit Details & Comparison Views) */

/**
 * Generate the HTML of the files & lines changed by a commit, for the Changes column.
 * @param stats The stats of the commit (NULL if the commit doesn't change any files).
 * @returns The HTML.
 */
function generateCommitStatsHtml(stats: GG.GitCommitStats | null) {
	return stats !== null
		? '<span title="' + (stats.files !== 1 ? t('{0} files', stats.files) : t('{0} file', stats.files)) + '">' + generateChangeBarHtml(stats.additions, stats.deletions, 36) + '<span class="fileTreeFileAdd">+' + stats.additions + '</span><span class="fileTreeFileDel">\u2212' + stats.deletions + '</span></span>'
		: '';
}

/**
 * Generate the HTML of how many commits a branch is ahead / behind its upstream branch.
 * @param upstream The upstream of the branch (if it has one).
 * @returns The HTML.
 */
function generateTrackingHtml(upstream: GG.GitBranchUpstream | undefined) {
	if (typeof upstream === 'undefined' || upstream.gone || (upstream.ahead === 0 && upstream.behind === 0)) return '';
	const title = [upstream.ahead > 0 ? t('{0} commit(s) ahead of {1}', upstream.ahead, upstream.name) : null, upstream.behind > 0 ? t('{0} commit(s) behind {1}', upstream.behind, upstream.name) : null].filter((text) => text !== null).join(', ');
	return '<span class="gitRefTrack" title="' + escapeHtml(title) + '">' + (upstream.ahead > 0 ? '\u2191' + upstream.ahead : '') + (upstream.behind > 0 ? '\u2193' + upstream.behind : '') + '</span>';
}

/**
 * Get the commits that match a filter, with their parents rewritten to be their nearest ancestors that also match (as Git does when it
 * simplifies the history of a path), so that the graph of the matching commits remains connected.
 * @param commits The commits, ordered so that each commit is before its parents (as they're returned by Git).
 * @param filter The hashes of the commits that match.
 * @returns The matching commits.
 */
function filterCommits(commits: ReadonlyArray<GG.GitCommit>, filter: ReadonlySet<string>) {
	const lookup: { [hash: string]: number } = {}, nearestMatches: { [hash: string]: string[] } = {}, filtered: GG.GitCommit[] = [];
	commits.forEach((commit, index) => lookup[commit.hash] = index);
	const rewriteParents = (parents: ReadonlyArray<string>) => {
		const rewritten: string[] = [];
		parents.forEach((parent) => {
			// Parents that aren't loaded are kept, as the graph continues below the loaded commits
			(filter.has(parent) || typeof lookup[parent] !== 'number' ? [parent] : nearestMatches[parent] || []).forEach((hash) => {
				if (!rewritten.includes(hash)) rewritten.push(hash);
			});
		});
		return rewritten;
	};
	for (let i = commits.length - 1; i >= 0; i--) {
		const commit = commits[i];
		if (filter.has(commit.hash)) {
			filtered.push(Object.assign({}, commit, { parents: rewriteParents(commit.parents) }));
		} else {
			nearestMatches[commit.hash] = rewriteParents(commit.parents);
		}
	}
	return filtered.reverse();
}

/**
 * Generate the HTML of a unified diff (as output by git diff), limited to a number of lines.
 * @param diff The diff.
 * @param maxLines The maximum number of lines of the diff to show.
 * @returns The HTML.
 */
function generateFileDiffHtml(diff: string, maxLines: number) {
	let html = '', shown = 0, hunks = 0, hiddenHunks = 0, oldLine = 0, newLine = 0, inHunk = false, truncatedHunk = false;
	const row = (oldNumber: number | null, newNumber: number | null, type: string, text: string) => {
		html += '<div class="cdvFileDiffLine ' + type + '"><span>' + (oldNumber !== null ? oldNumber : '') + '</span><span>' + (newNumber !== null ? newNumber : '') + '</span><span>' + (type === 'add' ? '+' : type === 'del' ? '\u2212' : ' ') + '</span><span>' + escapeHtml(text) + '</span></div>';
		shown++;
	};
	diff.split('\n').forEach((line) => {
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
		if (hunk !== null) {
			hunks++;
			if (shown >= maxLines) {
				hiddenHunks++;
				inHunk = false;
				return;
			}
			oldLine = parseInt(hunk[1]);
			newLine = parseInt(hunk[2]);
			inHunk = true;
			html += '<div class="cdvFileDiffHunk">' + escapeHtml(line) + '</div>';
			return;
		}
		if (!inHunk) return;
		if (shown >= maxLines) {
			truncatedHunk = true;
			return;
		}
		const type = line.charAt(0), text = line.substring(1);
		if (type === '+') {
			row(null, newLine++, 'add', text);
		} else if (type === '-') {
			row(oldLine++, null, 'del', text);
		} else if (type === ' ') {
			row(oldLine++, newLine++, 'context', text);
		}
	});
	if (hunks === 0) {
		return '<div class="cdvFileDiffMessage">' + (/^Binary files /m.test(diff) ? t('This is a binary file') : t('There are no changes to display')) + '</div>';
	}
	return '<div class="cdvFileDiffLines">' + html + (truncatedHunk ? '<div class="cdvFileDiffLine context"><span></span><span></span><span></span><span>' + ELLIPSIS + '</span></div>' : '') + '</div>' +
		(truncatedHunk || hiddenHunks > 0 ? '<div class="cdvFileDiffMore">' + (hiddenHunks > 0 ? (hiddenHunks !== 1 ? t('{0} more changes', hiddenHunks) : t('1 more change')) + ' · ' : '') + '<span class="cdvFileDiffOpen">' + t('Open in Diff Editor to view all of the changes') + '</span></div>' : '');
}

function generateFileViewHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, type: GG.FileViewType, isUncommitted: boolean) {
	fileViewMaxLinesChanged = gitFiles.reduce((max, file) => Math.max(max, (file.additions || 0) + (file.deletions || 0)), 1);
	return type === GG.FileViewType.List
		? generateFileListHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted)
		: generateFileTreeHtml(folder, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, true);
}

function generateFileTreeHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean, topLevelFolder: boolean): string {
	const curFolderInfo = topLevelFolder || !initialState.config.commitDetailsView.fileTreeCompactFolders
		? { folder: folder, name: folder.name, pathSeg: folder.name }
		: getCurrentFolderInfo(folder, folder.name, folder.name);

	const children = sortFolderKeys(curFolderInfo.folder).map((key) => {
		const cur = curFolderInfo.folder.contents[key];
		return cur.type === 'folder'
			? generateFileTreeHtml(cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted, false)
			: generateFileTreeLeafHtml(cur.name, cur, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
	});

	return (topLevelFolder ? '' : '<li' + (curFolderInfo.folder.open ? '' : ' class="closed"') + ' data-pathseg="' + encodeURIComponent(curFolderInfo.pathSeg) + '"><span class="fileTreeFolder' + (curFolderInfo.folder.reviewed ? '' : ' pendingReview') + '" title="./' + escapeHtml(curFolderInfo.folder.folderPath) + '" data-folderpath="' + encodeURIComponent(curFolderInfo.folder.folderPath) + '"><span class="fileTreeFolderIcon">' + fileIcons.getFolderIcon(curFolderInfo.folder.name, curFolderInfo.folder.open) + '</span><span class="gitFolderName">' + escapeHtml(curFolderInfo.name) + '</span></span>') +
		'<ul class="fileTreeFolderContents' + (curFolderInfo.folder.open ? '' : ' hidden') + '">' + children.join('') + '</ul>' +
		(topLevelFolder ? '' : '</li>');
}

function getCurrentFolderInfo(folder: FileTreeFolder, name: string, pathSeg: string): { folder: FileTreeFolder, name: string, pathSeg: string } {
	const keys = Object.keys(folder.contents);
	let child: FileTreeNode;
	return keys.length === 1 && (child = folder.contents[keys[0]]).type === 'folder'
		? getCurrentFolderInfo(<FileTreeFolder>child, name + ' / ' + child.name, pathSeg + '/' + child.name)
		: { folder: folder, name: name, pathSeg: pathSeg };
}

/**
 * The maximum number of lines changed in a file of the file view being generated, used to scale the bars of the lines changed in each file.
 */
let fileViewMaxLinesChanged = 1;

/**
 * Get the HTML Element containing the file view of the Commit Details View.
 * @returns The HTML Element, or NULL if the Commit Details View isn't open.
 */
function getCdvFileViewElem() {
	return document.getElementById('cdvFileView') || document.getElementById('cdvFiles');
}

/**
 * Generate the HTML of a bar showing the proportion of lines added & deleted.
 * @param additions The number of lines added.
 * @param deletions The number of lines deleted.
 * @param width The width of the bar (in pixels), or NULL if it fills the available space.
 * @returns The HTML.
 */
function generateChangeBarHtml(additions: number, deletions: number, width: number | null) {
	return '<span class="changeBar"' + (width !== null ? ' style="width:' + width + 'px"' : '') + '><span class="changeBarAdd" style="flex-grow:' + additions + '"></span><span class="changeBarDel" style="flex-grow:' + deletions + '"></span></span>';
}

/**
 * Generate the HTML of the number of files changed, and the lines added & deleted, in the Commit Details View.
 * @param fileChanges The files changed.
 * @returns The HTML.
 */
function generateCdvStatsHtml(fileChanges: ReadonlyArray<GG.GitFileChange>) {
	let additions = 0, deletions = 0;
	fileChanges.forEach((file) => {
		additions += file.additions || 0;
		deletions += file.deletions || 0;
	});
	return '<div class="cdvStats"><span>' + (fileChanges.length !== 1 ? t('{0} files', fileChanges.length) : t('{0} file', fileChanges.length)) + '</span>' +
		'<span class="fileTreeFileAdd">+' + additions + '</span><span class="fileTreeFileDel">\u2212' + deletions + '</span>' + generateChangeBarHtml(additions, deletions, null) + '</div>';
}

function generateFileListHtml(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean) {
	const sortLeaves = (folder: FileTreeFolder, folderPath: string) => {
		let keys = sortFolderKeys(folder);
		let items: { relPath: string, leaf: FileTreeLeaf }[] = [];
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			let relPath = (folderPath !== '' ? folderPath + '/' : '') + cur.name;
			if (cur.type === 'folder') {
				items = items.concat(sortLeaves(cur, relPath));
			} else {
				items.push({ relPath: relPath, leaf: cur });
			}
		}
		return items;
	};
	let sortedLeaves = sortLeaves(folder, '');
	let html = '';
	for (let i = 0; i < sortedLeaves.length; i++) {
		html += generateFileTreeLeafHtml(sortedLeaves[i].relPath, sortedLeaves[i].leaf, gitFiles, lastViewedFile, fileContextMenuOpen, isUncommitted);
	}
	return '<ul class="fileTreeFolderContents">' + html + '</ul>';
}

/**
 * Get the label displayed for the original path of a renamed file. Only the original file name is displayed if the file was renamed within the same directory.
 * @param oldFilePath The original path of the file.
 * @param newFilePath The new path of the file.
 * @returns The label.
 */
function getRenamedFromLabel(oldFilePath: string, newFilePath: string) {
	const oldDirectoryEnd = oldFilePath.lastIndexOf('/'), newDirectoryEnd = newFilePath.lastIndexOf('/');
	return oldFilePath.substring(0, oldDirectoryEnd + 1) === newFilePath.substring(0, newDirectoryEnd + 1)
		? oldFilePath.substring(oldDirectoryEnd + 1)
		: oldFilePath;
}

function generateFileTreeLeafHtml(name: string, leaf: FileTreeLeaf, gitFiles: ReadonlyArray<GG.GitFileChange>, lastViewedFile: string | null, fileContextMenuOpen: number, isUncommitted: boolean) {
	let encodedName = encodeURIComponent(name), escapedName = escapeHtml(name);
	if (leaf.type === 'file') {
		const fileTreeFile = gitFiles[leaf.index];
		const textFile = fileTreeFile.additions !== null && fileTreeFile.deletions !== null;
		const diffPossible = fileTreeFile.type === GG.GitFileStatus.Untracked || textFile;
		const changeTypeMessage = t(GIT_FILE_CHANGE_TYPES[fileTreeFile.type]) + (fileTreeFile.type === GG.GitFileStatus.Renamed ? ' (' + escapeHtml(fileTreeFile.oldFilePath) + ' → ' + escapeHtml(fileTreeFile.newFilePath) + ')' : '');
		const renamedFromHtml = fileTreeFile.type === GG.GitFileStatus.Renamed ? '<span class="gitFileRenamedFrom">← ' + escapeHtml(getRenamedFromLabel(fileTreeFile.oldFilePath, fileTreeFile.newFilePath)) + '</span>' : '';
		const dirEnd = name.lastIndexOf('/');
		const nameHtml = dirEnd > -1
			? '<span class="gitFileName ' + fileTreeFile.type + '">' + escapeHtml(name.substring(dirEnd + 1)) + '</span>' + renamedFromHtml + '<span class="gitFileDir">' + escapeHtml(name.substring(0, dirEnd)) + '</span>'
			: '<span class="gitFileName ' + fileTreeFile.type + '">' + escapedName + '</span>' + renamedFromHtml;
		return '<li data-pathseg="' + encodedName + '"><span class="fileTreeFileRecord' + (leaf.index === fileContextMenuOpen ? ' ' + CLASS_CONTEXT_MENU_ACTIVE : '') + '" data-index="' + leaf.index + '"><span class="fileTreeFile' + (diffPossible ? ' gitDiffPossible' : '') + (leaf.reviewed ? '' : ' ' + CLASS_PENDING_REVIEW) + '" title="' + (diffPossible ? t('Click to View Diff') : t('Unable to View Diff{0}', (fileTreeFile.type !== GG.GitFileStatus.Deleted ? t(' (this is a binary file)') : ''))) + ' • ' + changeTypeMessage + '"><span class="fileTreeFileBadge ' + fileTreeFile.type + '">' + fileTreeFile.type + '</span>' + fileIcons.getFileIcon(fileTreeFile.newFilePath) + '<span class="fileTreeFileText">' + nameHtml + '</span></span>' +
			(initialState.config.enhancedAccessibility ? '<span class="fileTreeFileType" title="' + changeTypeMessage + '">' + fileTreeFile.type + '</span>' : '') +
			(textFile ? '<span class="fileTreeFileAddDel">' + generateChangeBarHtml(fileTreeFile.additions!, fileTreeFile.deletions!, Math.round(8 + 52 * (fileTreeFile.additions! + fileTreeFile.deletions!) / fileViewMaxLinesChanged)) + '<span class="fileTreeFileAdd" title="' + (fileTreeFile.additions !== 1 ? t('{0} additions', fileTreeFile.additions) : t('{0} addition', fileTreeFile.additions)) + '">+' + fileTreeFile.additions + '</span><span class="fileTreeFileDel" title="' + (fileTreeFile.deletions !== 1 ? t('{0} deletions', fileTreeFile.deletions) : t('{0} deletion', fileTreeFile.deletions)) + '">\u2212' + fileTreeFile.deletions + '</span></span>' : '') +
			(fileTreeFile.newFilePath === lastViewedFile ? '<span id="cdvLastFileViewed" title="' + t('Last File Viewed') + '">' + SVG_ICONS.eyeOpen + '</span>' : '') +
			'<span class="copyGitFile fileTreeFileAction" title="' + t('Copy Absolute File Path to Clipboard') + '">' + SVG_ICONS.copy + '</span>' +
			(fileTreeFile.type !== GG.GitFileStatus.Deleted
				? (diffPossible && !isUncommitted ? '<span class="viewGitFileAtRevision fileTreeFileAction" title="' + t('View File at this Revision') + '">' + SVG_ICONS.commit + '</span>' : '') +
				'<span class="openGitFile fileTreeFileAction" title="' + t('Open File') + '">' + SVG_ICONS.openFile + '</span>'
				: ''
			) + '</span></li>';
	} else {
		return '<li data-pathseg="' + encodedName + '"><span class="fileTreeRepo" data-path="' + encodeURIComponent(leaf.path) + '" title="' + t('Click to View Repository') + '"><span class="fileTreeRepoIcon">' + SVG_ICONS.closedFolder + '</span>' + escapedName + '</span></li>';
	}
}

function alterFileTreeFolderOpen(folder: FileTreeFolder, folderPath: string, open: boolean) {
	let path = folderPath.split('/'), i, cur = folder;
	for (i = 0; i < path.length; i++) {
		if (typeof cur.contents[path[i]] !== 'undefined') {
			cur = <FileTreeFolder>cur.contents[path[i]];
			if (i === path.length - 1) cur.open = open;
		} else {
			return;
		}
	}
}

function alterFileTreeFileReviewed(folder: FileTreeFolder, filePath: string, reviewed: boolean) {
	let path = filePath.split('/'), i, cur = folder, folders = [folder];
	for (i = 0; i < path.length; i++) {
		if (typeof cur.contents[path[i]] !== 'undefined') {
			if (i < path.length - 1) {
				cur = <FileTreeFolder>cur.contents[path[i]];
				folders.push(cur);
			} else {
				(<FileTreeFile>cur.contents[path[i]]).reviewed = reviewed;
			}
		} else {
			break;
		}
	}

	// Recalculate whether each of the folders leading to the file are now reviewed (deepest first).
	for (i = folders.length - 1; i >= 0; i--) {
		let keys = Object.keys(folders[i].contents), entireFolderReviewed = true;
		for (let j = 0; j < keys.length; j++) {
			let cur = folders[i].contents[keys[j]];
			if ((cur.type === 'folder' || cur.type === 'file') && !cur.reviewed) {
				entireFolderReviewed = false;
				break;
			}
		}
		folders[i].reviewed = entireFolderReviewed;
	}
}

function setFileTreeReviewed(folder: FileTreeFolder, reviewed: boolean) {
	folder.reviewed = reviewed;
	let keys = Object.keys(folder.contents);
	for (let i = 0; i < keys.length; i++) {
		let cur = folder.contents[keys[i]];
		if (cur.type === 'folder') {
			setFileTreeReviewed(cur, reviewed);
		} else if (cur.type === 'file') {
			cur.reviewed = reviewed;
		}
	}
}

function calcFileTreeFoldersReviewed(folder: FileTreeFolder) {
	const calc = (folder: FileTreeFolder) => {
		let reviewed = true;
		let keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			if ((cur.type === 'folder' && !calc(cur)) || (cur.type === 'file' && !cur.reviewed)) reviewed = false;
		}
		folder.reviewed = reviewed;
		return reviewed;
	};
	calc(folder);
}

function updateFileTreeHtml(elem: HTMLElement, folder: FileTreeFolder) {
	let ul = getChildUl(elem);
	if (ul === null) return;

	for (let i = 0; i < ul.children.length; i++) {
		let li = <HTMLLIElement>ul.children[i];
		let pathSeg = decodeURIComponent(li.dataset.pathseg!);
		let child = getChildByPathSegment(folder, pathSeg);
		if (child.type === 'folder') {
			alterClass(<HTMLSpanElement>li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
			updateFileTreeHtml(li, child);
		} else if (child.type === 'file') {
			alterClass(<HTMLSpanElement>li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
		}
	}
}

function updateFileTreeHtmlFileReviewed(elem: HTMLElement, folder: FileTreeFolder, filePath: string) {
	let path = filePath;
	const update = (elem: HTMLElement, folder: FileTreeFolder) => {
		let ul = getChildUl(elem);
		if (ul === null) return;

		for (let i = 0; i < ul.children.length; i++) {
			let li = <HTMLLIElement>ul.children[i];
			let pathSeg = decodeURIComponent(li.dataset.pathseg!);
			if (path === pathSeg || path.startsWith(pathSeg + '/')) {
				let child = getChildByPathSegment(folder, pathSeg);
				if (child.type === 'folder') {
					alterClass(<HTMLSpanElement>li.children[0], CLASS_PENDING_REVIEW, !child.reviewed);
					path = path.substring(pathSeg.length + 1);
					update(li, child);
				} else if (child.type === 'file') {
					alterClass(<HTMLSpanElement>li.children[0].children[0], CLASS_PENDING_REVIEW, !child.reviewed);
				}
				break;
			}
		}
	};
	update(elem, folder);
}

function getFilesInTree(folder: FileTreeFolder, gitFiles: ReadonlyArray<GG.GitFileChange>) {
	let files: string[] = [];
	const scanFolder = (folder: FileTreeFolder) => {
		let keys = Object.keys(folder.contents);
		for (let i = 0; i < keys.length; i++) {
			let cur = folder.contents[keys[i]];
			if (cur.type === 'folder') {
				scanFolder(cur);
			} else if (cur.type === 'file') {
				files.push(gitFiles[cur.index].newFilePath);
			}
		}
	};
	scanFolder(folder);
	return files;
}

function sortFolderKeys(folder: FileTreeFolder) {
	let keys = Object.keys(folder.contents);
	keys.sort((a, b) => folder.contents[a].type !== 'file' && folder.contents[b].type === 'file' ? -1 : folder.contents[a].type === 'file' && folder.contents[b].type !== 'file' ? 1 : folder.contents[a].name.localeCompare(folder.contents[b].name));
	return keys;
}

function getChildByPathSegment(folder: FileTreeFolder, pathSeg: string) {
	let cur: FileTreeNode = folder, comps = pathSeg.split('/');
	for (let i = 0; i < comps.length; i++) {
		cur = (<FileTreeFolder>cur).contents[comps[i]];
	}
	return cur;
}


/* Repository State Helpers */

function getCommitOrdering(repoValue: GG.RepoCommitOrdering): GG.CommitOrdering {
	switch (repoValue) {
		case GG.RepoCommitOrdering.Default:
			return initialState.config.commitOrdering;
		case GG.RepoCommitOrdering.Date:
			return GG.CommitOrdering.Date;
		case GG.RepoCommitOrdering.AuthorDate:
			return GG.CommitOrdering.AuthorDate;
		case GG.RepoCommitOrdering.Topological:
			return GG.CommitOrdering.Topological;
	}
}

function getShowRemoteBranches(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.showRemoteBranches
		: repoValue === GG.BooleanOverride.Enabled;
}

function getShowStashes(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.showStashes
		: repoValue === GG.BooleanOverride.Enabled;
}

function getShowTags(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.showTags
		: repoValue === GG.BooleanOverride.Enabled;
}

function getIncludeCommitsMentionedByReflogs(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.includeCommitsMentionedByReflogs
		: repoValue === GG.BooleanOverride.Enabled;
}

function getOnlyFollowFirstParent(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.onlyFollowFirstParent
		: repoValue === GG.BooleanOverride.Enabled;
}

function getOnRepoLoadShowCheckedOutBranch(repoValue: GG.BooleanOverride) {
	return repoValue === GG.BooleanOverride.Default
		? initialState.config.onRepoLoad.showCheckedOutBranch
		: repoValue === GG.BooleanOverride.Enabled;
}

function getOnRepoLoadShowSpecificBranches(repoValue: string[] | null) {
	return repoValue === null
		? initialState.config.onRepoLoad.showSpecificBranches
		: repoValue;
}


/* Miscellaneous Helper Methods */

function haveFilesChanged(oldFiles: ReadonlyArray<GG.GitFileChange> | null, newFiles: ReadonlyArray<GG.GitFileChange> | null) {
	if ((oldFiles === null) !== (newFiles === null)) {
		return true;
	} else if (oldFiles === null && newFiles === null) {
		return false;
	} else {
		return !arraysEqual(oldFiles!, newFiles!, (a, b) => a.additions === b.additions && a.deletions === b.deletions && a.newFilePath === b.newFilePath && a.oldFilePath === b.oldFilePath && a.type === b.type);
	}
}

function abbrevCommit(commitHash: string) {
	return commitHash.substring(0, 8);
}

function getRepoDropdownOptions(repos: Readonly<GG.GitRepoSet>) {
	const repoPaths = getSortedRepositoryPaths(repos, initialState.config.repoDropdownOrder);
	const paths: string[] = [], names: string[] = [], distinctNames: string[] = [], firstSep: number[] = [];
	const resolveAmbiguous = (indexes: number[]) => {
		// Find ambiguous names within indexes
		let firstOccurrence: { [name: string]: number } = {}, ambiguous: { [name: string]: number[] } = {};
		for (let i = 0; i < indexes.length; i++) {
			let name = distinctNames[indexes[i]];
			if (typeof firstOccurrence[name] === 'number') {
				// name is ambiguous
				if (typeof ambiguous[name] === 'undefined') {
					// initialise ambiguous array with the first occurrence
					ambiguous[name] = [firstOccurrence[name]];
				}
				ambiguous[name].push(indexes[i]); // append current ambiguous index
			} else {
				firstOccurrence[name] = indexes[i]; // set the first occurrence of the name
			}
		}

		let ambiguousNames = Object.keys(ambiguous);
		for (let i = 0; i < ambiguousNames.length; i++) {
			// For each ambiguous name, resolve the ambiguous indexes
			let ambiguousIndexes = ambiguous[ambiguousNames[i]], retestIndexes = [];
			for (let j = 0; j < ambiguousIndexes.length; j++) {
				let ambiguousIndex = ambiguousIndexes[j];
				let nextSep = paths[ambiguousIndex].lastIndexOf('/', paths[ambiguousIndex].length - distinctNames[ambiguousIndex].length - 2);
				if (firstSep[ambiguousIndex] < nextSep) {
					// prepend the addition path and retest
					distinctNames[ambiguousIndex] = paths[ambiguousIndex].substring(nextSep + 1);
					retestIndexes.push(ambiguousIndex);
				} else {
					distinctNames[ambiguousIndex] = paths[ambiguousIndex];
				}
			}
			if (retestIndexes.length > 1) {
				// If there are 2 or more indexes that may be ambiguous
				resolveAmbiguous(retestIndexes);
			}
		}
	};

	// Initialise recursion
	const indexes = [];
	for (let i = 0; i < repoPaths.length; i++) {
		firstSep.push(repoPaths[i].indexOf('/'));
		const repo = repos[repoPaths[i]];
		if (repo.name) {
			// A name has been set for the repository
			paths.push(repoPaths[i]);
			names.push(repo.name);
			distinctNames.push(repo.name);
		} else if (firstSep[i] === repoPaths[i].length - 1 || firstSep[i] === -1) {
			// Path has no slashes, or a single trailing slash ==> use the path as the name
			paths.push(repoPaths[i]);
			names.push(repoPaths[i]);
			distinctNames.push(repoPaths[i]);
		} else {
			paths.push(repoPaths[i].endsWith('/') ? repoPaths[i].substring(0, repoPaths[i].length - 1) : repoPaths[i]); // Remove trailing slash if it exists
			let name = paths[i].substring(paths[i].lastIndexOf('/') + 1);
			names.push(name);
			distinctNames.push(name);
			indexes.push(i);
		}
	}
	resolveAmbiguous(indexes);

	const options: DropdownOption[] = [];
	for (let i = 0; i < repoPaths.length; i++) {
		let hint;
		if (names[i] === distinctNames[i]) {
			// Name is distinct, no hint needed
			hint = '';
		} else {
			// Hint path is the prefix of the distinctName before the common suffix with name
			let hintPath = distinctNames[i].substring(0, distinctNames[i].length - names[i].length - 1);

			// Keep two informative directories
			let hintComps = hintPath.split('/');
			let keepDirs = hintComps[0] !== '' ? 2 : 3;
			if (hintComps.length > keepDirs) hintComps.splice(keepDirs, hintComps.length - keepDirs, '...');

			// Construct the hint
			hint = (distinctNames[i] !== paths[i] ? '.../' : '') + hintComps.join('/');
		}
		options.push({ name: names[i], value: repoPaths[i], hint: hint });
	}
	return options;
}

function runAction(msg: GG.RequestMessage, action: string) {
	dialog.showActionRunning(action);
	sendMessage(msg);
}

function getBranchLabels(heads: ReadonlyArray<string>, remotes: ReadonlyArray<GG.GitCommitRemote>) {
	let headLabels: { name: string; remotes: string[] }[] = [], headLookup: { [name: string]: number } = {}, remoteLabels: ReadonlyArray<GG.GitCommitRemote>;
	for (let i = 0; i < heads.length; i++) {
		headLabels.push({ name: heads[i], remotes: [] });
		headLookup[heads[i]] = i;
	}
	if (initialState.config.referenceLabels.combineLocalAndRemoteBranchLabels) {
		let remainingRemoteLabels = [];
		for (let i = 0; i < remotes.length; i++) {
			if (remotes[i].remote !== null) { // If the remote of the remote branch ref is known
				let branchName = remotes[i].name.substring(remotes[i].remote!.length + 1);
				if (typeof headLookup[branchName] === 'number') {
					headLabels[headLookup[branchName]].remotes.push(remotes[i].remote!);
					continue;
				}
			}
			remainingRemoteLabels.push(remotes[i]);
		}
		remoteLabels = remainingRemoteLabels;
	} else {
		remoteLabels = remotes;
	}
	return { heads: headLabels, remotes: remoteLabels };
}

function findCommitElemWithId(elems: HTMLCollectionOf<HTMLElement>, id: number | null) {
	if (id === null) return null;
	let findIdStr = id.toString();
	for (let i = 0; i < elems.length; i++) {
		if (findIdStr === elems[i].dataset.id) return elems[i];
	}
	return null;
}

function generateSignatureHtml(signature: GG.GitSignature) {
	return '<span class="signatureInfo ' + signature.status + '" title="' + t(GIT_SIGNATURE_STATUS_DESCRIPTIONS[signature.status]) + ': '
		+ t('Signed by {0} (GPG Key Id: {1})', escapeHtml(signature.signer !== '' ? signature.signer : t('<Unknown>')), escapeHtml(signature.key !== '' ? signature.key : t('<Unknown>'))) + '">'
		+ (signature.status === GG.GitSignatureStatus.GoodAndValid
			? SVG_ICONS.passed
			: signature.status === GG.GitSignatureStatus.Bad
				? SVG_ICONS.failed
				: SVG_ICONS.inconclusive)
		+ '</span>';
}

/**
 * Generate the HTML of a circle containing the initial of an author's name, coloured by the name (used when avatars aren't fetched).
 * @param name The name of the author.
 * @returns The HTML.
 */
function generateAuthorInitialHtml(name: string, asPseudoElement: boolean = false) {
	const initial = name.trim().length > 0 ? name.trim().charAt(0).toUpperCase() : '?';
	// The initial can be shown by CSS, so that it isn't part of the text content of the element containing it (e.g. a dropdown option)
	return asPseudoElement
		? '<span class="authorInitial" data-initial="' + escapeHtml(initial) + '" style="background-color:' + getAuthorColour(name) + '"></span>'
		: '<span class="authorInitial" style="background-color:' + getAuthorColour(name) + '">' + escapeHtml(initial) + '</span>';
}

function closeDialogAndContextMenu() {
	if (dialog.isOpen()) dialog.close();
	if (contextMenu.isOpen()) contextMenu.close();
}
