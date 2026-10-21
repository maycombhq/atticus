/** Vite's `?url` import: the file is copied into the build as is and this is its address. */
declare module "*?url" {
  const url: string;
  export default url;
}
