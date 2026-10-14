# 名称规整规格

`src/slug.mjs` 导出的 `slugify(name, options)` 把名称规整成可用的 slug。

## 输入

- `name`：字符串。其余一律抛错。
- `options`：可选。两个字段都可以省略：
  - `fallback`（默认 `'untitled'`）：必须是**非空字符串**，否则抛错。
  - `maxLength`（默认 `40`）：必须是**正整数**，否则抛错。

## 规则

1. `name` 不是字符串时抛错；`fallback` 不是非空字符串、`maxLength` 不是正整数时抛错。
2. 把 `name` 转成小写。
3. 把**每一段连续**的非 `a`–`z`／`0`–`9` 字符替换成**一个** `-`。
4. 去掉结果首尾的 `-`。
5. 若第 4 步之后是空串，返回 `fallback`。
6. 否则若长度超过 `maxLength`，截到前 `maxLength` 个字符，再**去掉尾部可能剩下的 `-`**。
7. 其余情况原样返回。

## 例子

- `slugify('Hello World')` → `'hello-world'`
- `slugify('')` → `'untitled'`
- `slugify(42)` → 抛错
