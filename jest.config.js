module.exports = {
	roots: ['./tests'],
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: './tests/tsconfig.json' }]
	},
	testRegex: '\\.test\\.ts$',
	moduleFileExtensions: ['ts', 'js'],
	fakeTimers: {
		legacyFakeTimers: true
	},
	collectCoverageFrom: [
		'src/utils/*.ts',
		'src/*.ts'
	]
};
