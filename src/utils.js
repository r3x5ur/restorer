const prettier = require('prettier')
const { traverse, parseSync, File } = require('@babel/core')
const t = require('@babel/types')
const { ifStatement } = require('@babel/types')
const generator = require('@babel/generator').default

// 解析语法树
function parseAstSync(code, filename = 'temp.js') {
  const ast = parseSync(code, { sourceFileName: filename, sourceType: 'script' })
  return new File({ filename }, { ast, code })
}

// 生成字面量
function createLiteral(value, type = null) {
  type = type || typeof value
  const tMap = {
    number: t.numericLiteral,
    string: t.stringLiteral,
    boolean: t.booleanLiteral,
    null: t.nullLiteral,
    undefined: t.identifier,
  }
  return tMap[type](value)
}

/**
 * @param {string} code
 * @description
 * 1. 还原字符串编码
 * 2. 还原数字16进制写法
 * 3. 对象属性简写
 * 4. 移除死分支
 * 5. 给循环体加上大括号
 * 6. 给IfStatement的consequent和alternate加上大括号
 * 7. 将三元表达式转换为if语句
 * */
function restoreCode(code) {
  const bf = parseAstSync(code)
  const toBlock = node => t.blockStatement([t.expressionStatement(node.node || node)])
  traverse(bf.ast, {
    BinaryExpression(path) {
      if (path.get('left').isLiteral() && path.get('right').isLiteral()) {
        const value = path.evaluate().value
        path.replaceWith(createLiteral(value))
        if (path.parentPath.isIfStatement()) {
          const parent = path.parentPath
          const key = value ? 'consequent' : 'alternate'
          const block = parent.get(key)
          const pathList = block.isBlockStatement() ? block.get('body') : [block]
          parent.replaceWithMultiple(pathList.map(p => p.node))
        }
      }
    },
    MemberExpression(path) {
      const property = path.get('property')
      if (!property.isStringLiteral()) return
      const name = property.node.value
      if (!checkIdentifier(name)) return
      const { object } = path.node
      path.replaceWith(t.memberExpression(object, t.identifier(name), false))
    },
    NumericLiteral(path) {
      const node = path.node
      if (node.extra && !/^\d+$/.test(node.extra.raw)) {
        path.replaceWith(createLiteral(node.value))
      }
    },
    StringLiteral(path) {
      const node = path.node
      if (node.extra && node.extra.raw !== node.value) {
        path.replaceWith(t.stringLiteral(node.value))
      }
    },
    'WhileStatement|DoWhileStatement|ForStatement|ForInStatement|ForOfStatement'(path) {
      path.ensureBlock()
    },
    IfStatement(path) {
      const consequent = path.get('consequent')
      const alternate = path.get('alternate')
      if (!consequent.isBlockStatement()) {
        consequent.replaceWith(t.blockStatement([consequent.node]))
      }
      if (alternate.node && !alternate.isBlockStatement()) {
        alternate.replaceWith(t.blockStatement([alternate.node]))
      }
    },
    ConditionalExpression(path) {
      const consequent = path.get('consequent')
      const alternate = path.get('alternate')
      if (!consequent.isSequenceExpression() && !alternate.isSequenceExpression()) return
      if (!path.parentPath.isStatement()) return
      const test = path.get('test')
      const ifs = ifStatement(test.node, toBlock(consequent), toBlock(alternate))
      path.parentPath.replaceWith(ifs)
    },
  })
  return generatorByBabelFile(bf)
}

/**
 * @param {string} code
 * @description
 * 1. 去除句号表达式
 * */
function removeSequence(code) {
  const bf = parseAstSync(code)
  traverse(bf.ast, {
    VariableDeclaration(path) {
      if (path) return
      const node = path.node
      if (node.declarations.length < 2) return
      path.replaceInline(node.declarations.map(d => t.variableDeclaration(node.kind, [d])))
    },
    SequenceExpression(path) {
      if (path) return
      const _parentPath = path.parentPath
      const exps = path.node.expressions
      const targetStatements = exps.map(e => t.expressionStatement(e))
      if (_parentPath.isExpressionStatement()) {
        _parentPath.replaceInline(targetStatements)
        return
      }
      const parentBlock = path.findParent(p => p.node && Array.isArray(p.node.body))
      const index = parentBlock.node.body.findIndex(node => path.findParent(p => p.node === node))
      if (index !== -1) {
        const nodeList = parentBlock.node.body.slice(0, index)
        nodeList.push(...targetStatements.slice(0, -1))
        nodeList.push(...parentBlock.node.body.slice(index))
        parentBlock.replaceWith(t.blockStatement(nodeList))
        path.replaceWith(exps.slice(-1)[0])
      }
    },
    CallExpression(path) {
      if (path) return
      const node = path.node
      if (t.isIdentifier(node.callee) && node.callee.name === 'alert') {
        path.replaceWith(t.callExpression(t.identifier('console.log'), node.arguments))
        return
      }
      if (!t.isMemberExpression(node.callee)) return
      if (!t.isStringLiteral(node.arguments[0])) return
      if (node.callee.property.name !== 'join') return
      if (!t.isCallExpression(node.callee.object)) return
      if (!t.isMemberExpression(node.callee.object.callee)) return
      if (node.callee.object.callee.property.name !== 'reverse') return
      if (!t.isCallExpression(node.callee.object.callee.object)) return
      if (!t.isMemberExpression(node.callee.object.callee.object.callee)) return
      if (node.callee.object.callee.object.callee.property.name !== 'split') return
      if (!t.isStringLiteral(node.callee.object.callee.object.callee.object)) return
      const str = node.callee.object.callee.object.callee.object.value
      path.replaceWith(t.stringLiteral(str.split('').reverse().join('')))
    },
  })
  return generatorByBabelFile(bf)
}

function removeBadCode(code) {
  code = restoreCode(code)
  code = removeSequence(code)
  return code
}

function generatorByBabelFile(bf) {
  return generator(
    bf.ast,
    {
      jsescOption: {
        minimal: true,
        quotes: 'single',
      },
    },
    bf.code
  ).code
}

function reformat(code) {
  return prettier.format(code, {
    parser: 'babel',
    // 行尾需要有分号
    semi: true,
    // 使用单引号代替双引号
    singleQuote: true,
    // 对象的 key 仅在必要时用引号
    quoteProps: 'as-needed',
  })
}

function checkIdentifier(name) {
  if (!name || /\d+/.test(name[0])) return false
  const invalidCharactersRegex = /[^a-zA-Z0-9_$]/g
  return !invalidCharactersRegex.test(name)
}

module.exports = {
  removeBadCode,
  parseAstSync,
  createLiteral,
  traverse,
  babelTypes: t,
  generatorByBabelFile,
  reformat,
}
