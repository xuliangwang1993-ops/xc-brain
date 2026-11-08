// 主脑宪章 ESLint 规则
// 违规 → CI 拒绝合并，错误信息明示宪章条款
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    files: ['src/brain/**/*.ts'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: { parser: tsParser },
    rules: {
      // ─── 主脑宪章：禁止直接调用外部服务 ───────────────────
      'no-restricted-syntax': [
        'error',
        {
          // 禁止 fetch / axios / node-fetch
          selector: "CallExpression[callee.name='fetch']",
          message: '主脑宪章违规：主脑不得直接调用外部 API（fetch）',
        },
        {
          selector: "MemberExpression[object.name='axios']",
          message: '主脑宪章违规：主脑不得直接调用外部 API（axios）',
        },
        {
          // 禁止 supabase.from(
          selector: "CallExpression[callee.property.name='from'][callee.object.name='supabase']",
          message: '主脑宪章违规：主脑不得直接访问数据库（supabase.from）',
        },
        {
          // 禁止 subRouter.chat(
          selector: "CallExpression[callee.property.name='chat'][callee.object.name='subRouter']",
          message: '主脑宪章违规：主脑不得直接调用模型（subRouter.chat）',
        },
        {
          // 禁止读取 process.env（密钥值）
          selector: "MemberExpression[object.object.name='process'][object.property.name='env']",
          message: '主脑宪章违规：主脑不得读取 process.env（不持有密钥值）',
        },
        {
          // 禁止直接 toolRegistry.call（已由 delegate 代替）
          selector: "CallExpression[callee.property.name='call'][callee.object.name='toolRegistry']",
          message: '主脑宪章违规：主脑不得直接调用工具，只能通过 brain.delegate()',
        },
      ],
    },
  },
];
