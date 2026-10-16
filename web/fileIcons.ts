/**
 * Built-in icons of common file types, used when Visual Studio Code doesn't use a file icon theme (or it couldn't be read).
 */
const FALLBACK_FILE_ICONS: { readonly [extension: string]: { readonly text: string, readonly colour: string } } = {
	'ts': { text: 'TS', colour: '#519aba' }, 'tsx': { text: 'TS', colour: '#519aba' }, 'mts': { text: 'TS', colour: '#519aba' }, 'cts': { text: 'TS', colour: '#519aba' },
	'js': { text: 'JS', colour: '#cbcb41' }, 'jsx': { text: 'JS', colour: '#cbcb41' }, 'mjs': { text: 'JS', colour: '#cbcb41' }, 'cjs': { text: 'JS', colour: '#cbcb41' },
	'json': { text: '{}', colour: '#cbcb41' }, 'jsonc': { text: '{}', colour: '#cbcb41' },
	'css': { text: '#', colour: '#519aba' }, 'scss': { text: '#', colour: '#f55385' }, 'less': { text: '#', colour: '#519aba' },
	'html': { text: '<>', colour: '#e37933' }, 'htm': { text: '<>', colour: '#e37933' }, 'xml': { text: '<>', colour: '#e37933' }, 'vue': { text: 'V', colour: '#8dc149' },
	'md': { text: 'M↓', colour: '#519aba' }, 'markdown': { text: 'M↓', colour: '#519aba' },
	'py': { text: 'PY', colour: '#519aba' }, 'go': { text: 'GO', colour: '#519aba' }, 'rs': { text: 'RS', colour: '#e37933' }, 'java': { text: 'J', colour: '#cc3e44' },
	'c': { text: 'C', colour: '#519aba' }, 'h': { text: 'H', colour: '#a074c4' }, 'cpp': { text: 'C+', colour: '#519aba' }, 'cs': { text: 'C#', colour: '#519aba' },
	'sh': { text: '$', colour: '#4d5a5e' }, 'yml': { text: '≡', colour: '#a074c4' }, 'yaml': { text: '≡', colour: '#a074c4' }, 'toml': { text: '≡', colour: '#6d8086' },
	'svg': { text: '◆', colour: '#a074c4' }, 'png': { text: '▣', colour: '#a074c4' }, 'jpg': { text: '▣', colour: '#a074c4' }, 'jpeg': { text: '▣', colour: '#a074c4' }, 'gif': { text: '▣', colour: '#a074c4' }
};

/**
 * Displays the icons of files & folders using the file icon theme of Visual Studio Code (as in its Explorer).
 */
class FileIcons {
	private theme: GG.FileIconTheme | null = null;
	private readonly styleElem: HTMLStyleElement;

	/**
	 * Construct a new FileIcons instance.
	 */
	constructor() {
		this.styleElem = document.createElement('style');
		document.head.appendChild(this.styleElem);
	}

	/**
	 * Set the file icon theme used by Visual Studio Code.
	 * @param theme The file icon theme, or NULL if no file icon theme is used.
	 */
	public setTheme(theme: GG.FileIconTheme | null) {
		this.theme = theme;
		this.styleElem.textContent = theme !== null
			? theme.fonts.map((font, index) =>
				'@font-face{font-family:"git-map-file-icons-' + index + '";src:url("' + cssEscape(font.src) + '")' + (font.format !== null ? ' format("' + cssEscape(font.format) + '")' : '') + ';font-weight:' + (font.weight !== null ? cssEscape(font.weight) : 'normal') + ';font-style:' + (font.style !== null ? cssEscape(font.style) : 'normal') + ';}' +
				'.fileTypeIcon.font' + index + '{font-family:"git-map-file-icons-' + index + '";' + (font.size !== null ? 'font-size:' + cssEscape(font.size) + ';' : '') + '}'
			).join('')
			: '';
	}

	/**
	 * Get the HTML of the icon of a file.
	 * @param path The path (or name) of the file.
	 * @returns The HTML.
	 */
	public getFileIcon(path: string) {
		const name = path.substring(path.lastIndexOf('/') + 1).toLowerCase();
		if (this.theme !== null) {
			const sections = this.getSections(this.theme);
			let definition = FileIcons.findMapping(sections, (section) => section.fileNames[name]);
			// The longest file extension is matched first (e.g. "d.ts" before "ts")
			for (let index = name.indexOf('.'); typeof definition === 'undefined' && index > -1; index = name.indexOf('.', index + 1)) {
				const extension = name.substring(index + 1);
				definition = FileIcons.findMapping(sections, (section) => section.fileExtensions[extension]);
			}
			if (typeof definition === 'undefined') definition = FileIcons.findMapping(sections, (section) => section.file !== null ? section.file : undefined);
			const html = typeof definition !== 'undefined' ? this.getDefinitionHtml(this.theme, definition) : null;
			if (html !== null) return html;
		}
		const extension = name.substring(name.lastIndexOf('.') + 1), fallback = name.includes('.') ? FALLBACK_FILE_ICONS[extension] : undefined;
		return typeof fallback !== 'undefined'
			? '<span class="fileTypeIcon text" style="color:' + fallback.colour + '">' + escapeHtml(fallback.text) + '</span>'
			: '<span class="fileTypeIcon svg">' + SVG_ICONS.file + '</span>';
	}

	/**
	 * Get the HTML of the icon of a folder.
	 * @param name The name of the folder.
	 * @param open Is the folder open (expanded).
	 * @returns The HTML.
	 */
	public getFolderIcon(name: string, open: boolean) {
		if (this.theme !== null) {
			const sections = this.getSections(this.theme), key = name.toLowerCase();
			const definition = FileIcons.findMapping(sections, (section) => open ? section.folderNamesExpanded[key] : section.folderNames[key])
				|| FileIcons.findMapping(sections, (section) => (open ? section.folderExpanded : section.folder) || undefined);
			const html = typeof definition !== 'undefined' ? this.getDefinitionHtml(this.theme, definition) : null;
			if (html !== null) return html;
		}
		return '<span class="fileTypeIcon svg">' + (open ? SVG_ICONS.openFolder : SVG_ICONS.closedFolder) + '</span>';
	}

	/**
	 * Get the sections of the file icon theme that apply to the current colour theme (light & high contrast themes can override the icons).
	 * @param theme The file icon theme.
	 * @returns The sections, in order of priority.
	 */
	private getSections(theme: GG.FileIconTheme) {
		const sections: GG.FileIconThemeMappings[] = [];
		if (theme.highContrast !== null && document.body.classList.contains('vscode-high-contrast')) sections.push(theme.highContrast);
		if (theme.light !== null && (document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light'))) sections.push(theme.light);
		sections.push(theme);
		return sections;
	}

	/**
	 * Get the HTML of an icon definition of the file icon theme.
	 * @param theme The file icon theme.
	 * @param id The id of the icon definition.
	 * @returns The HTML, or NULL if the theme doesn't define the icon.
	 */
	private getDefinitionHtml(theme: GG.FileIconTheme, id: string) {
		const definition = theme.definitions[id];
		if (typeof definition === 'undefined') return null;
		if (definition.iconPath !== null) {
			return '<span class="fileTypeIcon image" style="background-image:url(&quot;' + escapeHtml(cssEscape(definition.iconPath)) + '&quot;)"></span>';
		} else if (definition.fontCharacter !== null) {
			const fontIndex = definition.fontId !== null ? theme.fonts.findIndex((font) => font.id === definition.fontId) : 0;
			return '<span class="fileTypeIcon font' + Math.max(fontIndex, 0) + '" style="' + (definition.fontColor !== null ? 'color:' + escapeHtml(definition.fontColor) + ';' : '') + (definition.fontSize !== null ? 'font-size:' + escapeHtml(definition.fontSize) + ';' : '') + '">' + escapeHtml(definition.fontCharacter) + '</span>';
		}
		return null;
	}

	/**
	 * Find the first mapping in the sections of a file icon theme.
	 * @param sections The sections, in order of priority.
	 * @param getMapping Get the mapping of a section.
	 * @returns The id of the icon definition, or undefined if no section has the mapping.
	 */
	private static findMapping(sections: ReadonlyArray<GG.FileIconThemeMappings>, getMapping: (section: GG.FileIconThemeMappings) => string | undefined) {
		for (let i = 0; i < sections.length; i++) {
			const mapping = getMapping(sections[i]);
			if (typeof mapping === 'string') return mapping;
		}
		return undefined;
	}
}

/**
 * Escape a string for use in a quoted CSS string.
 * @param value The string.
 * @returns The escaped string.
 */
function cssEscape(value: string) {
	return value.replace(/["\\\n\r]/g, (char) => '\\' + char.charCodeAt(0).toString(16) + ' ');
}
