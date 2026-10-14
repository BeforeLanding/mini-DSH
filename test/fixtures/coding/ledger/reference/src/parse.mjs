// SPEC 第 1 节：制表符分隔的流水文件。表头是第 1 行、直接跳过；其后每行一条流水；字段个数不是 5、或
// 任一字段不合格式的行不计入流水，而是进 skipped，行号从 1 开始。
//
// 逐字段判，而不是把整行拼成一条正则：整行正则对字段边界的处理容易在坏行上悄悄放宽（`.*` 会跨过制表符
// 把两个字段吃成一个），而 skipped 要的正是「哪一行不合法」，粒度必须落在行上。
const ID_PATTERN = /^\S+$/
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/
const ACCOUNT_PATTERN = /^[A-Za-z0-9_-]+$/
const AMOUNT_PATTERN = /^-?\d+\.\d{2}$/
const CUSTOMER_PATTERN = /^\S+$/

// 每个月的天数，二月在下面按闰年单独算。
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

// SPEC 要求的是**真实存在的日期**，不是「形如日期的字符串」：`2026-02-30` 与 `2026-13-01` 形状都对，
// 但它们在流水里只会是录入错误，收进来会让后面的汇总凭空多出一笔不存在的账。月与日都要落到日历上。
function isCalendarDate(value) {
  const matched = DATE_PATTERN.exec(value)
  if (!matched) return false
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (month < 1 || month > 12) return false
  const limit = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]
  return day >= 1 && day <= limit
}

// 字段顺序与格式一一对应。写成表而不是一串 if，是为了让「第几个字段、什么格式」这件事只有一处定义：
// 列出一张表，解析循环就只剩「逐个比对」这一件事。
const FIELDS = [
  { name: 'id', ok: value => ID_PATTERN.test(value) },
  { name: 'date', ok: isCalendarDate },
  { name: 'account', ok: value => ACCOUNT_PATTERN.test(value) },
  { name: 'amount', ok: value => AMOUNT_PATTERN.test(value) },
  { name: 'customer', ok: value => CUSTOMER_PATTERN.test(value) },
]

export function parseJournal(text) {
  const entries = []
  const skipped = []
  const lines = text.split('\n')
  // 表头是第 1 行：SPEC 说它既不算流水也不进 skipped，所以循环从下标 1 开始，第 1 行连格式都不判。
  for (let index = 1; index < lines.length; index += 1) {
    // 手写或跨平台导出的文件可能带 CRLF：行尾的 \r 不属于任何字段，先剥掉再判格式，否则每个字段都会
    // 无端多出一个不可见字符，整份文件全被判成坏行。
    const line = lines[index].replace(/\r$/, '')
    // 空行（含只有空白字符的行）直接忽略：它既不是流水，也不是录入错误，进 skipped 会让行号对不上账。
    if (line.trim() === '') continue
    const fields = line.split('\t')
    // 字段个数不对时不再逐个判格式：`fields[1]` 之类会越界，而且「少了一列」本身就是它被跳过的原因。
    const wellFormed = fields.length === FIELDS.length
      && fields.every((field, at) => FIELDS[at].ok(field))
    if (!wellFormed) { skipped.push(index + 1); continue }
    // amount 按 SPEC 保留成字符串原样：两位小数与负号都要逐字留给第 2 节的换算，转成数字再格式化回去
    // 会把 `1200.00` 变成 `1200`，下游按「分」换算时少两位。
    const entry = {}
    for (const [at, field] of FIELDS.entries()) entry[field.name] = fields[at]
    entries.push(entry)
  }
  return { entries, skipped }
}
