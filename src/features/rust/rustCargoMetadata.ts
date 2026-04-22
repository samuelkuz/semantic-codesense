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

export function inferRustModulePath(
  filePath: string,
  cargoWorkspace?: CargoWorkspaceContext
): string {
  const normalizedFilePath = normalizeFilePath(filePath);
  const matchingPackageRoot = cargoWorkspace
    ? resolvePackageRoot(normalizedFilePath, cargoWorkspace)
    : undefined;
  const crateRoot = matchingPackageRoot ?? normalizeFilePath(path.dirname(filePath));
  const relativePath = normalizeFilePath(path.relative(crateRoot, normalizedFilePath));
  const pathSegments = relativePath.split("/").filter((segment) => segment !== "");

  if (pathSegments.length === 0) {
    return "crate";
  }

  if (pathSegments[0] === "src") {
    const moduleSegments = pathSegments.slice(1);

    if (moduleSegments.length === 0) {
      return "crate";
    }

    const fileName = moduleSegments[moduleSegments.length - 1];
    const stem = fileName.replace(/\.rs$/, "");
    const normalizedSegments = moduleSegments.slice(0, -1);

    if (stem !== "lib" && stem !== "main" && stem !== "mod") {
      normalizedSegments.push(stem);
    }

    return normalizedSegments.length === 0
      ? "crate"
      : `crate::${normalizedSegments.join("::")}`;
  }

  const fallbackStem = path.basename(normalizedFilePath, path.extname(normalizedFilePath));
  return fallbackStem === "" ? "crate" : fallbackStem;
}

function resolvePackageRoot(
  filePath: string,
  cargoWorkspace: CargoWorkspaceContext
): string | undefined {
  const matchingPackage = cargoWorkspace.packages
    .map((pkg) => normalizeFilePath(path.dirname(pkg.manifestPath)))
    .filter((pkgRoot) => filePath.startsWith(`${pkgRoot}/`) || filePath === pkgRoot)
    .sort((left, right) => right.length - left.length)[0];

  return matchingPackage;
}

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
