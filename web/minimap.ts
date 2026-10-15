const MINIMAP_MAX_BARS = 120;
const MINIMAP_BAR_MAX_HEIGHT = 22;
const SECONDS_PER_DAY = 86400;

interface MinimapBucket {
	readonly start: number; // The local day number of the start of the bucket
	count: number;
	firstIndex: number; // The index of the newest commit in the bucket
}

interface MinimapMarker {
	readonly bucket: number;
	readonly kind: 'head' | 'branch' | 'tag';
	readonly colour: string;
	readonly title: string;
}

/**
 * Implements the Minimap of the Git Graph View: the number of loaded commits each day (or week / month when the commits span a long time),
 * where HEAD, branches & tags are, and the commits that are currently visible. Clicking on a day scrolls to its commits.
 */
class Minimap {
	private readonly elem: HTMLElement;
	private readonly onClick: (commitIndex: number) => void;
	private buckets: MinimapBucket[] = [];
	private bucketDays: number = 1;
	private firstDay: number = 0;
	private commitDays: number[] = [];
	private viewportElem: HTMLElement | null = null;

	/**
	 * Construct a new Minimap instance.
	 * @param elem The HTML Element that the minimap is rendered in.
	 * @param onClick A callback invoked with the index of the newest commit of the day that was clicked.
	 */
	constructor(elem: HTMLElement, onClick: (commitIndex: number) => void) {
		this.elem = elem;
		this.onClick = onClick;
		this.elem.addEventListener('click', (e) => {
			const barElem = e.target instanceof Element ? <HTMLElement | null>e.target.closest('.minimapBar') : null;
			if (barElem === null || typeof barElem.dataset.index !== 'string') return;
			const bucket = this.buckets[parseInt(barElem.dataset.index)];
			if (typeof bucket !== 'undefined' && bucket.count > 0) this.onClick(bucket.firstIndex);
		});
	}

	/**
	 * Render the minimap for the loaded commits.
	 * @param commits The loaded commits.
	 * @param commitHead The hash of the commit referenced by HEAD.
	 * @param vertexColours The colour index of each commit's vertex on the graph.
	 * @param colours The colours of the graph.
	 * @param enabled Is the minimap enabled (the `git-graph.graph.minimap` Extension Setting).
	 */
	public render(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, vertexColours: ReadonlyArray<number>, colours: ReadonlyArray<string>, enabled: boolean) {
		this.buckets = [];
		this.commitDays = commits.map((commit) => Minimap.getLocalDay(commit.date));
		this.viewportElem = null;
		const days = this.commitDays.filter((_, i) => commits[i].hash !== UNCOMMITTED);
		alterClass(this.elem, 'active', enabled && days.length > 0);
		if (!enabled || days.length === 0) {
			this.elem.innerHTML = '';
			return;
		}

		const newestDay = Math.max.apply(null, days), oldestDay = Math.min.apply(null, days);
		const numDays = newestDay - oldestDay + 1;
		this.bucketDays = numDays <= MINIMAP_MAX_BARS ? 1 : numDays <= MINIMAP_MAX_BARS * 7 ? 7 : Math.ceil(numDays / MINIMAP_MAX_BARS / 30) * 30;
		const numBuckets = Math.max(Math.ceil(numDays / this.bucketDays), this.bucketDays === 1 ? 30 : 1); // Show at least 30 days
		this.firstDay = newestDay - numBuckets * this.bucketDays + 1;
		for (let i = 0; i < numBuckets; i++) {
			this.buckets.push({ start: this.firstDay + i * this.bucketDays, count: 0, firstIndex: -1 });
		}

		const markers: MinimapMarker[] = [], markedBuckets: { [key: string]: boolean } = {};
		const addMarker = (marker: MinimapMarker) => {
			const key = marker.bucket + marker.kind + marker.colour;
			if (!markedBuckets[key]) {
				markedBuckets[key] = true;
				markers.push(marker);
			}
		};
		for (let i = 0; i < commits.length; i++) {
			if (commits[i].hash === UNCOMMITTED) continue;
			const bucketIndex = this.getBucketIndex(this.commitDays[i]), bucket = this.buckets[bucketIndex];
			if (typeof bucket === 'undefined') continue;
			bucket.count++;
			if (bucket.firstIndex === -1) bucket.firstIndex = i;

			if (commits[i].hash === commitHead) {
				addMarker({ bucket: bucketIndex, kind: 'head', colour: 'var(--vscode-focusBorder)', title: 'HEAD' });
			}
			if (commits[i].heads.length > 0 || commits[i].remotes.length > 0) {
				addMarker({ bucket: bucketIndex, kind: 'branch', colour: colours[vertexColours[i] % colours.length], title: commits[i].heads.concat(commits[i].remotes.map((remote) => remote.name)).join(', ') });
			}
			if (commits[i].tags.length > 0) {
				addMarker({ bucket: bucketIndex, kind: 'tag', colour: 'var(--vscode-descriptionForeground)', title: commits[i].tags.map((tag) => tag.name).join(', ') });
			}
		}

		const maxCount = Math.max.apply(null, this.buckets.map((bucket) => bucket.count));
		const left = (bucketIndex: number) => ((bucketIndex + 0.5) / this.buckets.length * 100).toFixed(3) + '%';
		this.elem.innerHTML = '<span class="minimapTitle">' + t('Activity') + '</span>'
			+ '<div class="minimapChart">'
			+ '<div class="minimapMarkers">' + markers.map((marker) => '<span class="minimapMarker ' + marker.kind + '" style="left:' + left(marker.bucket) + ';background-color:' + escapeHtml(marker.colour) + '" title="' + escapeHtml(marker.title) + '"></span>').join('') + '</div>'
			+ '<div class="minimapBars">' + this.buckets.map((bucket, i) => '<span class="minimapBar' + (bucket.count > 0 ? '' : ' empty') + '" data-index="' + i + '" title="' + escapeHtml(this.getBucketLabel(bucket) + ': ' + t('{0} commits', bucket.count)) + '" style="height:' + (bucket.count > 0 ? 3 + Math.round((MINIMAP_BAR_MAX_HEIGHT - 3) * Math.sqrt(bucket.count / maxCount)) : 1) + 'px"></span>').join('') + '</div>'
			+ '<div id="minimapViewport"></div>'
			+ '<div class="minimapAxis"><span>' + escapeHtml(this.getBucketLabel(this.buckets[0])) + '</span><span>' + escapeHtml(this.getBucketLabel(this.buckets[this.buckets.length - 1])) + '</span></div>'
			+ '</div>';
		this.viewportElem = document.getElementById('minimapViewport');
	}

	/**
	 * Show which commits are currently visible on the minimap.
	 * @param firstIndex The index of the first visible commit.
	 * @param lastIndex The index of the last visible commit.
	 */
	public setViewport(firstIndex: number, lastIndex: number) {
		if (this.viewportElem === null || this.buckets.length === 0 || firstIndex < 0 || lastIndex < firstIndex || lastIndex >= this.commitDays.length) return;
		const newestBucket = Math.min(this.getBucketIndex(this.commitDays[firstIndex]), this.buckets.length - 1);
		const oldestBucket = Math.max(this.getBucketIndex(this.commitDays[lastIndex]), 0);
		this.viewportElem.style.left = (oldestBucket / this.buckets.length * 100).toFixed(3) + '%';
		this.viewportElem.style.width = ((newestBucket - oldestBucket + 1) / this.buckets.length * 100).toFixed(3) + '%';
	}

	private getBucketIndex(day: number) {
		return Math.floor((day - this.firstDay) / this.bucketDays);
	}

	private getBucketLabel(bucket: MinimapBucket) {
		const date = new Date(bucket.start * SECONDS_PER_DAY * 1000);
		const label = t('{0} {1} {2}', date.getUTCDate(), t(MONTHS[date.getUTCMonth()]), date.getUTCFullYear());
		return this.bucketDays === 1 ? label : this.bucketDays === 7 ? t('Week of {0}', label) : t('{0} days from {1}', this.bucketDays, label);
	}

	/**
	 * Get the number of the local day (since 1 Jan 1970) of a Unix timestamp.
	 * @param unixTimestamp The Unix timestamp (in seconds).
	 * @returns The day number.
	 */
	private static getLocalDay(unixTimestamp: number) {
		const offset = -new Date(unixTimestamp * 1000).getTimezoneOffset() * 60;
		return Math.floor((unixTimestamp + offset) / SECONDS_PER_DAY);
	}
}


/**
 * Implements the markers on the right edge of the Git Graph View (alongside its scrollbar), that show where HEAD, branches, tags, stashes
 * & find matches are in the loaded commits.
 */
class ScrollMarkers {
	private readonly elem: HTMLElement;
	private readonly viewElem: HTMLElement;

	/**
	 * Construct a new ScrollMarkers instance.
	 * @param viewElem The scrolling element of the Git Graph View.
	 */
	constructor(viewElem: HTMLElement) {
		this.viewElem = viewElem;
		this.elem = document.createElement('div');
		this.elem.id = 'scrollMarkers';
		document.body.appendChild(this.elem);
	}

	/**
	 * Render the markers.
	 * @param commits The loaded commits.
	 * @param commitHead The hash of the commit referenced by HEAD.
	 * @param vertexColours The colour index of each commit's vertex on the graph.
	 * @param colours The colours of the graph.
	 * @param findMatches The hashes of the commits that match the Find Widget's criteria.
	 */
	public render(commits: ReadonlyArray<GG.GitCommit>, commitHead: string | null, vertexColours: ReadonlyArray<number>, colours: ReadonlyArray<string>, findMatches: ReadonlyArray<string>) {
		const viewRect = this.viewElem.getBoundingClientRect(), scrollHeight = this.viewElem.scrollHeight;
		this.elem.style.top = viewRect.top + 'px';
		this.elem.style.height = viewRect.height + 'px';
		this.elem.style.right = Math.max(window.innerWidth - viewRect.right, 0) + 'px';
		if (commits.length === 0 || scrollHeight <= this.viewElem.clientHeight) {
			this.elem.innerHTML = '';
			return;
		}

		const commitElems = getCommitElems(), viewTop = viewRect.top - this.viewElem.scrollTop, matches: { [hash: string]: boolean } = {};
		findMatches.forEach((hash) => matches[hash] = true);
		let html = '';
		for (let i = 0, j = 0; i < commits.length; i++) {
			const commit = commits[i];
			const kinds: { kind: string, colour: string }[] = [];
			if (matches[commit.hash]) kinds.push({ kind: 'findMatch', colour: 'var(--vscode-editorOverviewRuler-findMatchForeground, #d18616)' });
			if (commit.hash === commitHead) kinds.push({ kind: 'head', colour: 'var(--vscode-focusBorder)' });
			if (commit.hash === UNCOMMITTED || commit.stash !== null) kinds.push({ kind: 'other', colour: 'var(--vscode-descriptionForeground)' });
			if (commit.heads.length > 0 || commit.remotes.length > 0) kinds.push({ kind: 'branch', colour: colours[vertexColours[i] % colours.length] });
			if (commit.tags.length > 0) kinds.push({ kind: 'tag', colour: 'var(--vscode-descriptionForeground)' });
			if (kinds.length === 0) continue;

			const idStr = i.toString();
			while (j < commitElems.length && commitElems[j].dataset.id !== idStr) j++;
			if (j === commitElems.length) break;
			const rowRect = commitElems[j].getBoundingClientRect();
			const top = ((rowRect.top + rowRect.height / 2 - viewTop) / scrollHeight * 100).toFixed(3) + '%';
			html += kinds.map((marker) => '<span class="scrollMarker ' + marker.kind + '" style="top:' + top + ';background-color:' + escapeHtml(marker.colour) + '"></span>').join('');
		}
		this.elem.innerHTML = html;
	}
}
