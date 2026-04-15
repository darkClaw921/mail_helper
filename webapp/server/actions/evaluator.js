// evaluator.js — безопасный интерпретатор выражений match_expr для actions.
//
// Используется в actions/runner.js: для каждого enabled action вызывается
// evaluate(action.match_expr, classification) и если результат truthy —
// action выполняется.
//
// Безопасность:
//   * НЕ используется eval / new Function / vm.
//   * Парсер — рекурсивный спуск. Единственные доступные идентификаторы:
//       important, reason, tags, summary
//     (whitelist, задаётся ALLOWED_IDENTS). Любой другой ident — ошибка.
//   * Разрешён единственный вызов метода: <ident>.includes(<arg>) — для tags.
//     Никаких других member-access/property-access нет, так что `process.exit(...)`,
//     `constructor`, `__proto__`, `global.*` — всё отсекается на уровне парсинга.
//
// Поддерживаемые конструкции:
//   * Литералы: строки '...' / "...", числа, true, false, null
//   * Идентификаторы: important | reason | tags | summary
//   * Унарный: !expr
//   * Бинарные: == != && || (с обычными приоритетами)
//   * Скобки: ( expr )
//   * Метод: ident.includes(expr)
//
// API:
//   evaluate(expression, context) -> boolean
//     Возвращает Boolean() от результата. При пустом/невалидном выражении кидает Error.
//     context поля не-whitelist игнорируются; отсутствие поля => undefined в контексте.
//
//   compile(expression) -> (context) -> boolean
//     Парсит один раз, возвращает переиспользуемый evaluator.
//
// Примеры:
//   evaluate('important == true', { important: true })                  // true
//   evaluate('tags.includes("bill")', { tags: ['bill'] })               // true
//   evaluate('important && !tags.includes("spam")', { important:true, tags:[] }) // true
//   evaluate('process.exit(1)', {})                                      // throws

export const ALLOWED_IDENTIFIERS = Object.freeze(['important', 'reason', 'tags', 'summary']);
const ALLOWED_IDENT_SET = new Set(ALLOWED_IDENTIFIERS);
const ALLOWED_METHODS = new Set(['includes']);

// --- Lexer ---------------------------------------------------------------

const TOKEN = Object.freeze({
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  IDENT: 'IDENT',
  TRUE: 'TRUE',
  FALSE: 'FALSE',
  NULL: 'NULL',
  EQ: 'EQ', // ==
  NEQ: 'NEQ', // !=
  AND: 'AND', // &&
  OR: 'OR', // ||
  NOT: 'NOT', // !
  LPAREN: 'LPAREN',
  RPAREN: 'RPAREN',
  DOT: 'DOT',
  COMMA: 'COMMA',
  EOF: 'EOF',
});

function isDigit(c) {
  return c >= '0' && c <= '9';
}
function isIdentStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c) {
  return isIdentStart(c) || isDigit(c);
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // whitespace
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }

    // строковые литералы '…' или "…" с поддержкой экранирования \" \\ \n \t \'
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let value = '';
      while (i < n && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < n) {
          const esc = src[i + 1];
          switch (esc) {
            case 'n':
              value += '\n';
              break;
            case 't':
              value += '\t';
              break;
            case 'r':
              value += '\r';
              break;
            case '\\':
              value += '\\';
              break;
            case '"':
              value += '"';
              break;
            case "'":
              value += "'";
              break;
            default:
              value += esc;
          }
          i += 2;
          continue;
        }
        value += src[i];
        i++;
      }
      if (i >= n) throw new Error('evaluator: unterminated string literal');
      i++; // consume closing quote
      tokens.push({ type: TOKEN.STRING, value });
      continue;
    }

    // числовой литерал (int/float, без знака — унарный - в грамматике не нужен)
    if (isDigit(c)) {
      let start = i;
      while (i < n && isDigit(src[i])) i++;
      if (i < n && src[i] === '.') {
        i++;
        while (i < n && isDigit(src[i])) i++;
      }
      tokens.push({ type: TOKEN.NUMBER, value: Number(src.slice(start, i)) });
      continue;
    }

    // идентификатор или зарезервированное слово
    if (isIdentStart(c)) {
      let start = i;
      i++;
      while (i < n && isIdentPart(src[i])) i++;
      const word = src.slice(start, i);
      if (word === 'true') tokens.push({ type: TOKEN.TRUE });
      else if (word === 'false') tokens.push({ type: TOKEN.FALSE });
      else if (word === 'null') tokens.push({ type: TOKEN.NULL });
      else tokens.push({ type: TOKEN.IDENT, value: word });
      continue;
    }

    // многосимвольные операторы
    if (c === '=' && src[i + 1] === '=') {
      tokens.push({ type: TOKEN.EQ });
      i += 2;
      continue;
    }
    if (c === '!' && src[i + 1] === '=') {
      tokens.push({ type: TOKEN.NEQ });
      i += 2;
      continue;
    }
    if (c === '&' && src[i + 1] === '&') {
      tokens.push({ type: TOKEN.AND });
      i += 2;
      continue;
    }
    if (c === '|' && src[i + 1] === '|') {
      tokens.push({ type: TOKEN.OR });
      i += 2;
      continue;
    }

    // односимвольные
    switch (c) {
      case '!':
        tokens.push({ type: TOKEN.NOT });
        i++;
        continue;
      case '(':
        tokens.push({ type: TOKEN.LPAREN });
        i++;
        continue;
      case ')':
        tokens.push({ type: TOKEN.RPAREN });
        i++;
        continue;
      case '.':
        tokens.push({ type: TOKEN.DOT });
        i++;
        continue;
      case ',':
        tokens.push({ type: TOKEN.COMMA });
        i++;
        continue;
      default:
        throw new Error(`evaluator: unexpected character '${c}' at position ${i}`);
    }
  }

  tokens.push({ type: TOKEN.EOF });
  return tokens;
}

// --- Parser --------------------------------------------------------------
//
// Грамматика (снизу вверх по приоритету):
//   OrExpr   := AndExpr ('||' AndExpr)*
//   AndExpr  := EqExpr ('&&' EqExpr)*
//   EqExpr   := UnaryExpr (('==' | '!=') UnaryExpr)*
//   UnaryExpr:= '!' UnaryExpr | Primary
//   Primary  := Literal | '(' OrExpr ')' | IdentOrCall
//   IdentOrCall := IDENT ('.' IDENT '(' OrExpr ')')?
//   Literal  := NUMBER | STRING | TRUE | FALSE | NULL

function parse(tokens) {
  let pos = 0;

  function peek() {
    return tokens[pos];
  }
  function consume(type) {
    const t = tokens[pos];
    if (t.type !== type) {
      throw new Error(`evaluator: expected ${type}, got ${t.type}`);
    }
    pos++;
    return t;
  }
  function match(type) {
    if (tokens[pos].type === type) {
      return tokens[pos++];
    }
    return null;
  }

  function parseOr() {
    let left = parseAnd();
    while (match(TOKEN.OR)) {
      const right = parseAnd();
      left = { kind: 'Or', left, right };
    }
    return left;
  }

  function parseAnd() {
    let left = parseEq();
    while (match(TOKEN.AND)) {
      const right = parseEq();
      left = { kind: 'And', left, right };
    }
    return left;
  }

  function parseEq() {
    let left = parseUnary();
    while (true) {
      if (match(TOKEN.EQ)) {
        const right = parseUnary();
        left = { kind: 'Eq', left, right };
      } else if (match(TOKEN.NEQ)) {
        const right = parseUnary();
        left = { kind: 'Neq', left, right };
      } else {
        break;
      }
    }
    return left;
  }

  function parseUnary() {
    if (match(TOKEN.NOT)) {
      const expr = parseUnary();
      return { kind: 'Not', expr };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === TOKEN.NUMBER) {
      pos++;
      return { kind: 'Literal', value: t.value };
    }
    if (t.type === TOKEN.STRING) {
      pos++;
      return { kind: 'Literal', value: t.value };
    }
    if (t.type === TOKEN.TRUE) {
      pos++;
      return { kind: 'Literal', value: true };
    }
    if (t.type === TOKEN.FALSE) {
      pos++;
      return { kind: 'Literal', value: false };
    }
    if (t.type === TOKEN.NULL) {
      pos++;
      return { kind: 'Literal', value: null };
    }
    if (t.type === TOKEN.LPAREN) {
      pos++;
      const expr = parseOr();
      consume(TOKEN.RPAREN);
      return expr;
    }
    if (t.type === TOKEN.IDENT) {
      return parseIdentOrCall();
    }
    throw new Error(`evaluator: unexpected token ${t.type}`);
  }

  function parseIdentOrCall() {
    const identTok = consume(TOKEN.IDENT);
    const name = identTok.value;
    if (!ALLOWED_IDENT_SET.has(name)) {
      throw new Error(
        `evaluator: identifier '${name}' is not allowed (allowed: ${ALLOWED_IDENTIFIERS.join(', ')})`,
      );
    }
    // опциональный .method(arg)
    if (match(TOKEN.DOT)) {
      const methodTok = consume(TOKEN.IDENT);
      const method = methodTok.value;
      if (!ALLOWED_METHODS.has(method)) {
        throw new Error(
          `evaluator: method '.${method}' is not allowed (allowed: ${[...ALLOWED_METHODS].join(', ')})`,
        );
      }
      consume(TOKEN.LPAREN);
      const arg = parseOr();
      // пока поддерживаем ровно один аргумент
      consume(TOKEN.RPAREN);
      return { kind: 'MethodCall', object: name, method, arg };
    }
    return { kind: 'Ident', name };
  }

  const ast = parseOr();
  if (tokens[pos].type !== TOKEN.EOF) {
    throw new Error(`evaluator: unexpected token ${tokens[pos].type} at end`);
  }
  return ast;
}

// --- Interpreter ---------------------------------------------------------

function evalNode(node, context) {
  switch (node.kind) {
    case 'Literal':
      return node.value;
    case 'Ident':
      // достаём только whitelisted — остальные заброшены на этапе парсинга,
      // но на всякий случай повторно проверяем.
      if (!ALLOWED_IDENT_SET.has(node.name)) {
        throw new Error(`evaluator: identifier '${node.name}' is not allowed`);
      }
      return context ? context[node.name] : undefined;
    case 'Not':
      return !evalNode(node.expr, context);
    case 'And': {
      const l = evalNode(node.left, context);
      if (!l) return l;
      return evalNode(node.right, context);
    }
    case 'Or': {
      const l = evalNode(node.left, context);
      if (l) return l;
      return evalNode(node.right, context);
    }
    case 'Eq':
      // Используем строгое равенство — операнды детерминированные (литералы + whitelist).
      return evalNode(node.left, context) === evalNode(node.right, context);
    case 'Neq':
      return evalNode(node.left, context) !== evalNode(node.right, context);
    case 'MethodCall': {
      if (!ALLOWED_IDENT_SET.has(node.object)) {
        throw new Error(`evaluator: identifier '${node.object}' is not allowed`);
      }
      const obj = context ? context[node.object] : undefined;
      const arg = evalNode(node.arg, context);
      if (node.method === 'includes') {
        if (Array.isArray(obj)) return obj.includes(arg);
        if (typeof obj === 'string') return typeof arg === 'string' && obj.includes(arg);
        // null/undefined/object без includes — false, не ошибка
        return false;
      }
      throw new Error(`evaluator: method '.${node.method}' is not implemented`);
    }
    default:
      throw new Error(`evaluator: unknown AST node '${node.kind}'`);
  }
}

/**
 * Спарсить выражение в переиспользуемый evaluator.
 * @param {string} expression
 * @returns {(context: object) => boolean}
 */
export function compile(expression) {
  if (typeof expression !== 'string') {
    throw new TypeError('evaluator: expression must be a string');
  }
  if (expression.trim() === '') {
    throw new Error('evaluator: expression is empty');
  }
  const tokens = tokenize(expression);
  const ast = parse(tokens);
  return (context) => Boolean(evalNode(ast, context || {}));
}

/**
 * Одноразовая оценка выражения.
 * @param {string} expression
 * @param {object} context — { important?, reason?, tags?, summary? }
 * @returns {boolean}
 */
export function evaluate(expression, context) {
  return compile(expression)(context);
}

export default { evaluate, compile, ALLOWED_IDENTIFIERS };
