const path = require('path');

module.exports = {
  mode: 'development',
  target: 'web',
  entry: './webview-ui/src/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist', 'webview'),
    filename: 'index.js',
    clean: false,
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    modules: [
      path.resolve(__dirname, 'webview-ui', 'node_modules'),
      path.resolve(__dirname, 'node_modules'),
    ],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            compilerOptions: {
              module: 'ESNext',
              moduleResolution: 'node',
              jsx: 'react-jsx',
              noEmit: false,
            },
          },
        },
      },
      { test: /\.css$/, type: 'asset/source' },
    ],
  },
  devtool: 'nosources-source-map',
};
