import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface CargoMetadataPackage {
  id: string;
  name: string;
  version: string;
  manifest_path: string;
}

interface CargoMetadataResponse {
  workspace_root: string;
  target_directory: string;
  workspace_members: string[];
  packages: CargoMetadataPackage[];
}

export interface CargoPackageContext {
  id: string;
  name: string;
  version: string;
  manifestPath: string;
}

export interface CargoWorkspaceContext {
  workspaceRoot: string;
  manifestPath: string;
  targetDirectory: string;
  workspaceMembers: string[];
  packages: CargoPackageContext[];
  currentPackage?: CargoPackageContext;
}

export async function findNearestCargoManifestPath(
  filePath: string
): Promise<string | undefined> {
  let currentDirectory = path.dirname(filePath);

  for (;;) {
    const manifestPath = path.join(currentDirectory, "Cargo.toml");

    try {
      await access(manifestPath, fsConstants.F_OK);
      return manifestPath;
    } catch {
      const parentDirectory = path.dirname(currentDirectory);

      if (parentDirectory === currentDirectory) {
        return undefined;
      }

      currentDirectory = parentDirectory;
    }
  }
}

export async function loadCargoWorkspaceContext(
  filePath: string
): Promise<CargoWorkspaceContext | undefined> {
  const manifestPath = await findNearestCargoManifestPath(filePath);

  if (!manifestPath) {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync(
      "cargo",
      ["metadata", "--format-version", "1", "--no-deps"],
      {
        cwd: path.dirname(manifestPath),
        maxBuffer: 10 * 1024 * 1024
      }
    );
    const metadata = JSON.parse(stdout) as CargoMetadataResponse;
    const packages = metadata.packages.map((pkg) => ({
      id: pkg.id,
      name: pkg.name,
      version: pkg.version,
      manifestPath: pkg.manifest_path
    }));
    const currentPackage = packages.find((pkg) => pkg.manifestPath === manifestPath);

    return {
      workspaceRoot: metadata.workspace_root,
      manifestPath,
      targetDirectory: metadata.target_directory,
      workspaceMembers: metadata.workspace_members,
      packages,
      currentPackage
    };
  } catch {
    return undefined;
  }
}
