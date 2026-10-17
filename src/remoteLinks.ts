import { GitLineRange } from './types';

/**
 * The kinds of hosts of remote repositories, which link to files & commits differently.
 */
export const enum RemoteHost {
	GitHub, // Also used for hosts that aren't recognised
	GitLab,
	Bitbucket,
	Gitea, // Gitea, Forgejo & Codeberg
	AzureDevOps
}

/**
 * A remote repository's web page.
 */
export interface RemoteWebRepo {
	readonly url: string; // The URL of the repository's web page (e.g. https://github.com/owner/repo)
	readonly host: RemoteHost;
}

/**
 * Get the web page of a remote repository from its URL (HTTPS, SSH, or SCP-like, e.g. git@github.com:owner/repo.git).
 * @param remoteUrl The URL of the remote.
 * @returns The web page of the repository, or NULL if the URL isn't recognised.
 */
export function getRemoteWebRepo(remoteUrl: string): RemoteWebRepo | null {
	const url = remoteUrl.trim();
	let match: RegExpMatchArray | null, webUrl: string;
	if ((match = url.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)\/?$/)) !== null || (match = url.match(/^[^@\s/]+@vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/(.+?)\/?$/)) !== null) {
		webUrl = 'https://dev.azure.com/' + match[1] + '/' + match[2] + '/_git/' + match[3];
	} else if ((match = url.match(/^(https?):\/\/(?:[^@/]+@)?(.+?)(?:\.git)?\/?$/)) !== null) {
		webUrl = match[1] + '://' + match[2];
	} else if ((match = url.match(/^ssh:\/\/(?:[^@/]+@)?([^:/]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/)) !== null) {
		webUrl = 'https://' + match[1] + '/' + match[2];
	} else if ((match = url.match(/^[^@\s/]+@([^:\s]+):(.+?)(?:\.git)?\/?$/)) !== null) {
		webUrl = 'https://' + match[1] + '/' + match[2];
	} else {
		return null;
	}
	const hostname = (webUrl.match(/^https?:\/\/([^/:]+)/) || ['', ''])[1].toLowerCase();
	const host = hostname === 'dev.azure.com' || hostname.endsWith('.visualstudio.com')
		? RemoteHost.AzureDevOps
		: hostname.includes('gitlab')
			? RemoteHost.GitLab
			: hostname.includes('bitbucket')
				? RemoteHost.Bitbucket
				: hostname.includes('gitea') || hostname.includes('forgejo') || hostname === 'codeberg.org'
					? RemoteHost.Gitea
					: RemoteHost.GitHub;
	return { url: webUrl, host: host };
}

/**
 * Get the URL of a commit on the web page of a remote repository.
 * @param repo The remote repository.
 * @param hash The hash of the commit.
 * @returns The URL.
 */
export function getRemoteCommitUrl(repo: RemoteWebRepo, hash: string) {
	switch (repo.host) {
		case RemoteHost.GitLab:
			return repo.url + '/-/commit/' + hash;
		case RemoteHost.Bitbucket:
			return repo.url + '/commits/' + hash;
		default:
			return repo.url + '/commit/' + hash;
	}
}

/**
 * Get the URL of lines of a file at a commit, on the web page of a remote repository (a permanent link, as it refers to the commit).
 * @param repo The remote repository.
 * @param hash The hash of the commit.
 * @param filePath The path of the file in the commit (relative to the repository).
 * @param range The lines (or NULL to link to the whole file).
 * @returns The URL.
 */
export function getRemoteFileUrl(repo: RemoteWebRepo, hash: string, filePath: string, range: GitLineRange | null) {
	const path = filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
	const single = range !== null && range.start === range.end;
	switch (repo.host) {
		case RemoteHost.GitLab:
			return repo.url + '/-/blob/' + hash + '/' + path + (range !== null ? '#L' + range.start + (single ? '' : '-' + range.end) : '');
		case RemoteHost.Bitbucket:
			return repo.url + '/src/' + hash + '/' + path + (range !== null ? '#lines-' + range.start + (single ? '' : ':' + range.end) : '');
		case RemoteHost.Gitea:
			return repo.url + '/src/commit/' + hash + '/' + path + (range !== null ? '#L' + range.start + (single ? '' : '-L' + range.end) : '');
		case RemoteHost.AzureDevOps:
			return repo.url + '?path=' + encodeURIComponent('/' + filePath) + '&version=GC' + hash +
				(range !== null ? '&line=' + range.start + '&lineEnd=' + (range.end + 1) + '&lineStartColumn=1&lineEndColumn=1&lineStyle=plain' : '') + '&_a=contents';
		default:
			return repo.url + '/blob/' + hash + '/' + path + (range !== null ? '#L' + range.start + (single ? '' : '-L' + range.end) : '');
	}
}
