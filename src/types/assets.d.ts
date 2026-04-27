declare module '*.bin' {
  const value: ArrayBuffer
  export default value
}

declare module '*.wasm?module' {
  const value: WebAssembly.Module
  export default value
}
