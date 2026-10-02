declare module "pdf-parse/lib/pdf-parse.js" {
  const pdfParse: (data: Buffer, options?: Record<string, unknown>) => Promise<{ text: string; numpages: number; info: unknown }>;
  export default pdfParse;
}
