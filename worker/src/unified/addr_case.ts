/**
 * 收件人地址（to_addr）的大小写语义。
 *
 * 背景：emails.to_addr 入库保留原始大小写（外部邮箱账号名形如
 * KevinWalters5892@outlook.com，来自聚合器 account.username），而查询侧
 * 习惯把入参统一 lower() 后再做二进制全等。SQLite 的 TEXT `=` 默认区分
 * 大小写，于是「邮件确实在库里，却查不出来」——验证码取码就是这样失效的。
 *
 * 两侧约定：
 * - 写侧：normalizeToAddr() 把 to_addr 归一成小写，新行从此是规范形态。
 * - 读侧：TO_ADDR_NOCASE 用 COLLATE NOCASE 比较，兼容存量的大小写混写行。
 *
 * COLLATE 必须写在比较的左操作数上：写成 `IN (...) COLLATE NOCASE` 会被
 * SQLite 当成对整个 IN 表达式指定排序规则，不生效；而
 * `to_addr COLLATE NOCASE = ?` 与 `to_addr = ? COLLATE NOCASE` 都能命中
 * NOCASE 索引，但只有左操作数形式在 `IN (subquery)` 下同样有效。
 */

/** 收件人地址的大小写不敏感比较表达式（比较的左操作数形式）。 */
export const TO_ADDR_NOCASE = "to_addr COLLATE NOCASE";

/**
 * 归一化收件人地址为小写规范形态。
 *
 * 只作用于 emails.to_addr 这一个「地址语义」列：source / account_id 是稳定
 * 标识（slug / UUID），绝不可折叠大小写。
 */
export const normalizeToAddr = (value: string): string => value.trim().toLowerCase();
