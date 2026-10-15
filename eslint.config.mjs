import stylistic from '@stylistic/eslint-plugin';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{
		files: ['src/**/*.ts', 'tests/**/*.ts', 'web/**/*.ts'],
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: {
				project: [
					'./src/tsconfig.json',
					'./tests/tsconfig.json',
					'./web/tsconfig.json'
				],
				tsconfigRootDir: import.meta.dirname
			}
		},
		linterOptions: {
			reportUnusedDisableDirectives: 'off'
		},
		plugins: {
			'@stylistic': stylistic,
			'@typescript-eslint': tseslint.plugin
		},
		rules: {
			'@stylistic/arrow-spacing': ['warn', { before: true, after: true }],
			'@stylistic/brace-style': ['warn', '1tbs', { allowSingleLine: true }],
			'@stylistic/comma-dangle': 'warn',
			'@stylistic/comma-spacing': 'warn',
			'@stylistic/comma-style': 'warn',
			'@stylistic/dot-location': ['warn', 'property'],
			'@stylistic/eol-last': 'warn',
			'@stylistic/function-call-spacing': 'warn',
			'@stylistic/indent': ['warn', 'tab', { SwitchCase: 1, ignoredNodes: ['TSConditionalType *'] }],
			'@stylistic/key-spacing': 'warn',
			'@stylistic/linebreak-style': ['warn', 'windows'],
			'@stylistic/new-parens': 'warn',
			'@stylistic/no-multi-spaces': 'warn',
			'@stylistic/no-trailing-spaces': 'warn',
			'@stylistic/no-whitespace-before-property': 'warn',
			'@stylistic/padded-blocks': ['warn', { classes: 'never', switches: 'never' }],
			'@stylistic/quotes': ['warn', 'single'],
			'@stylistic/rest-spread-spacing': 'warn',
			'@stylistic/semi': 'warn',
			'@stylistic/space-before-blocks': 'warn',
			'@stylistic/space-before-function-paren': ['warn', { anonymous: 'always', named: 'never', asyncArrow: 'always' }],
			'@stylistic/space-infix-ops': 'warn',
			'@stylistic/spaced-comment': 'warn',
			'@stylistic/template-curly-spacing': 'warn',
			'@stylistic/wrap-iife': ['warn', 'inside'],
			'eqeqeq': 'warn',
			'new-cap': 'warn',
			'no-alert': 'error',
			'no-console': 'error',
			'no-eval': 'error',
			'no-extra-boolean-cast': 'warn',
			'no-implied-eval': 'error',
			'no-irregular-whitespace': 'warn',
			'no-labels': 'error',
			'no-proto': 'error',
			'no-prototype-builtins': 'error',
			'no-redeclare': 'error',
			'no-global-assign': 'error',
			'no-shadow-restricted-names': 'error',
			'no-script-url': 'error',
			'no-sparse-arrays': 'warn',
			'no-throw-literal': 'warn',
			'no-unneeded-ternary': 'warn',
			'no-unsafe-negation': 'warn',
			'no-unused-expressions': 'warn',
			'no-var': 'warn',
			'no-with': 'error',
			'sort-imports': ['warn', { allowSeparatedGroups: true, ignoreDeclarationSort: true }],
			'yoda': 'warn',
			'@typescript-eslint/await-thenable': 'warn',
			'@typescript-eslint/ban-ts-comment': 'error',
			'@typescript-eslint/class-literal-property-style': ['warn', 'fields'],
			'@typescript-eslint/explicit-member-accessibility': ['warn', { overrides: { accessors: 'off', constructors: 'off' } }],
			'@typescript-eslint/method-signature-style': ['warn', 'property'],
			'@typescript-eslint/naming-convention': [
				'warn',
				{ selector: 'class', format: ['StrictPascalCase'] },
				{ selector: 'function', format: ['camelCase'] }
			],
			'@typescript-eslint/no-misused-new': 'warn',
			'@typescript-eslint/no-this-alias': 'warn',
			'@typescript-eslint/no-unnecessary-boolean-literal-compare': 'warn'
		}
	},
	{
		files: ['src/askpass/*.ts'],
		rules: {
			'no-console': 'off',
			'@stylistic/spaced-comment': 'off'
		}
	},
	{
		files: ['tests/mocks/*.ts'],
		rules: {
			'no-global-assign': 'off'
		}
	}
);
