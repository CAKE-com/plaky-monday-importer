import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const EFFECTS = ["useEffect", "useLayoutEffect", "useInsertionEffect"];
const NO_EFFECTS =
  "Effects are banned. Derive values during render, act in event handlers, load data with tRPC/React Query, reset state with `key`, " +
  "and wrap a real external subscription in a named hook on useSyncExternalStore or a ref callback.";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: [{ name: "react", importNames: EFFECTS, message: NO_EFFECTS }] }],
      "no-restricted-syntax": ["error", ...EFFECTS.map((name) => ({ selector: `MemberExpression[property.name="${name}"]`, message: NO_EFFECTS }))],
    },
  },
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "tmp/**", "data/**"]),
]);

export default eslintConfig;
