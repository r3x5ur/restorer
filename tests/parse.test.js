const { parseAstSync } = require('../src/utils')

describe('test  parse AST', () => {
  test('test parseAstSync func', () => {
    const code = 'console.log("hello")'
    const result = parseAstSync(code)
    expect(result.path.getSource()).toBe(code)
    expect(result).toHaveProperty('ast')
  })
})
