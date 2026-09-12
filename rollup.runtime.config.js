import commonjs from "@rollup/plugin-commonjs";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";

export default {
    input: "dist/runtime/index.js",
    output: [
        {
            file: "dist/zca-runtime.debug.js",
            format: "iife",
            name: "ZCARuntimeBundle",
            exports: "named",
            generatedCode: "es2015",
        },
        {
            file: "dist/zca-runtime.js",
            format: "iife",
            name: "ZCARuntimeBundle",
            exports: "named",
            generatedCode: "es2015",
            plugins: [
                terser({
                    compress: true,
                    mangle: true,
                    format: { comments: false },
                }),
            ],
        },
    ],
    plugins: [nodeResolve({ browser: true }), commonjs()],
};
