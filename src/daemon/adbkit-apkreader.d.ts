declare module "adbkit-apkreader" {
  interface Manifest {
    package: string;
    versionCode: number;
    versionName: string;
  }

  class ApkReader {
    static open(path: string): Promise<ApkReader>;
    readManifest(): Promise<Manifest>;
  }

  export default ApkReader;
}
