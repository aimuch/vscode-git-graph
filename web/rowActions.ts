const ROW_ACTION_ICONS: { readonly [action: string]: string } = {
	createBranch: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><path d="M4.5 5v6"/><path d="M4.5 9.5c0-2.5 2-3 4.5-3"/><path d="M12 4v5M9.5 6.5h5"/></svg>',
	checkout: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="8" r="3"/><path d="M1.5 8h6M5 5.5L7.5 8 5 10.5"/></svg>',
	cherrypick: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="4.5" cy="11.5" r="2.5"/><circle cx="11.5" cy="11.5" r="2.5"/><path d="M4.5 9c.5-3 3-5.5 6.5-6.5M11.5 9c-.5-2.5-.5-4.5-.5-6.5"/></svg>',
	copyHash: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3v5.5A1.5 1.5 0 0 0 3.5 10H4"/></svg>',
	more: '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/></svg>'
};

/**
 * Implements the buttons of the most common actions on a commit, shown at the end of its row while the mouse is over it (as in
 * GitLens): Create Branch, Checkout, Cherry Pick, Copy Commit Hash, and a button that opens the commit's context menu. They run the
 * same actions as the commit's context menu (and are hidden when the context menu doesn't show them).
 */
class RowActions {
	private readonly view: GitGraphView;
	private readonly elem: HTMLElement;
	private commitElem: HTMLElement | null = null;

	/**
	 * Construct a new RowActions instance.
	 * @param view The Git Map View.
	 */
	constructor(view: GitGraphView) {
		this.view = view;
		this.elem = document.createElement('div');
		this.elem.id = 'rowActions';
		this.elem.setAttribute('role', 'toolbar');
		this.elem.innerHTML = [
			['createBranch', t('Create Branch') + ELLIPSIS],
			['checkout', t('Checkout') + ELLIPSIS],
			['cherrypick', t('Cherry Pick') + ELLIPSIS],
			['copyHash', t('Copy Commit Hash to Clipboard')],
			['more', t('More Actions') + ELLIPSIS]
		].map((action) => '<button type="button" class="rowAction" data-action="' + action[0] + '" title="' + action[1] + '" aria-label="' + action[1] + '" tabindex="-1">' + ROW_ACTION_ICONS[action[0]] + '</button>').join('');

		// The buttons are inside the row, so their events aren't handled by the row (which would open the Commit Details View)
		this.elem.addEventListener('click', (e) => {
			handledEvent(e);
			const buttonElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.rowAction') : null;
			if (buttonElem !== null) this.run(buttonElem.dataset.action!, buttonElem);
		});
		['dblclick', 'contextmenu', 'mousedown'].forEach((type) => this.elem.addEventListener(type, (e) => e.stopPropagation()));
	}

	/**
	 * Show the buttons on the row of a commit (they aren't shown on the uncommitted changes & stashes).
	 * @param commitElem The row of the commit.
	 */
	public show(commitElem: HTMLElement) {
		if (commitElem === this.commitElem && this.elem.isConnected) return;
		const commit = this.view.getCommitOfElem(commitElem), cellElem = commitElem.querySelector('td.descriptionCol');
		if (commit === null || commit.hash === UNCOMMITTED || commit.stash !== null || cellElem === null) {
			this.hide();
			return;
		}
		const visibility = this.view.config.contextMenuActionsVisibility.commit;
		const visible: { [action: string]: boolean } = { createBranch: visibility.createBranch, checkout: visibility.checkout, cherrypick: visibility.cherrypick, copyHash: visibility.copyHash, more: true };
		this.elem.querySelectorAll<HTMLElement>('.rowAction').forEach((buttonElem) => {
			buttonElem.style.display = visible[buttonElem.dataset.action!] ? '' : 'none';
		});
		cellElem.appendChild(this.elem);
		this.commitElem = commitElem;
	}

	/**
	 * Hide the buttons.
	 */
	public hide() {
		this.elem.remove();
		this.commitElem = null;
	}

	/**
	 * Run an action on the commit whose buttons are shown.
	 * @param action The action.
	 * @param buttonElem The button of the action.
	 */
	private run(action: string, buttonElem: HTMLElement) {
		const commitElem = this.commitElem;
		const commit = commitElem !== null ? this.view.getCommitOfElem(commitElem) : null;
		if (commitElem === null || commit === null) return;
		const target: ContextMenuTarget & DialogTarget & CommitTarget = { type: TargetType.Commit, hash: commit.hash, index: parseInt(commitElem.dataset.id!), elem: commitElem };
		const actions = this.view.actions.getCommitContextMenuActions(target);
		if (action === 'more') {
			const bounds = buttonElem.getBoundingClientRect();
			contextMenu.show(actions, false, target, new MouseEvent('contextmenu', { clientX: Math.round(bounds.left), clientY: Math.round(bounds.bottom) }), this.view.viewElem);
		} else {
			for (const group of actions) {
				const item = group.find((item) => item.id === action);
				if (typeof item !== 'undefined') {
					item.onClick();
					return;
				}
			}
		}
	}
}
