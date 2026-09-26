import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import globals from "globals";

/** @type {import("eslint").Linter.Config[]} */
export default [
  // 构建产物与数据目录不检查
  { ignores: ["node_modules/**", "data/**"] },

  js.configs.recommended,

  // 后端 / 脚本 / 测试：Node 环境
  {
    files: ["server.js", "src/**/*.js", "scripts/**/*.mjs", "tests/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      // 有意的空 catch（例如“加载 .env 失败就忽略”）不应报错
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // 前端：浏览器环境，经典脚本（非 module）
  {
    files: ["public/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: {
      "no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none", ignoreRestSiblings: true },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // 关闭与 Prettier 冲突的格式类规则
  prettier,
];
