/**
 * Custom Contracts Discovery and Parsing Module
 *
 * This module provides functionality to automatically discover and parse
 * custom token contracts from the solidity/contracts/token/custom/ directory.
 *
 * It extracts constructor and initialize parameters along with their NatSpec
 * documentation to enable dynamic deployment through the CLI.
 */
import * as parser from '@solidity-parser/parser';
import * as fs from 'fs';
import * as path from 'path';

interface ArtifactInput {
  name: string;
  type: string;
}

interface ContractArtifact {
  contractName?: string;
  abi?: Array<{
    type?: string;
    name?: string;
    inputs?: ArtifactInput[];
  }>;
}

/**
 * Information about a single parameter
 */
export interface ParamInfo {
  name: string;
  type: string;
  description?: string;
}

/**
 * Complete metadata about a custom contract
 */
export interface CustomContractMetadata {
  name: string;
  filePath: string;
  constructorParams: ParamInfo[];
  initializeParams: ParamInfo[];
  contractDocs: {
    title?: string;
    notice?: string;
    dev?: string;
  };
}

/**
 * Find the monorepo root by looking for solidity/contracts directory
 */
function findMonorepoRoot(): string | null {
  let currentDir = process.cwd();

  // Try up to 5 levels up
  for (let i = 0; i < 5; i++) {
    const solidityPath = path.join(currentDir, 'solidity', 'contracts');
    if (fs.existsSync(solidityPath)) {
      return currentDir;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // Reached filesystem root
    currentDir = parentDir;
  }

  return null;
}

/**
 * Discovers all custom contracts in the custom directory
 * @param customDir Path to the custom contracts directory (defaults to workspace solidity/contracts/token/custom/)
 * @returns Array of custom contract metadata
 */
export async function discoverCustomContracts(
  customDir?: string,
): Promise<CustomContractMetadata[]> {
  let dir: string;

  if (customDir) {
    dir = customDir;
  } else {
    const monorepoRoot = findMonorepoRoot();
    if (!monorepoRoot) {
      return [];
    }
    dir = path.join(monorepoRoot, 'solidity', 'contracts', 'token', 'custom');
  }

  if (!fs.existsSync(dir)) {
    return [];
  }

  const files = fs.readdirSync(dir);
  const solidityFiles = files.filter((f) => f.endsWith('.sol'));

  const contracts: CustomContractMetadata[] = [];

  for (const file of solidityFiles) {
    try {
      const filePath = path.join(dir, file);
      const metadata = parseCustomContract(filePath);
      if (metadata) {
        contracts.push(metadata);
      }
    } catch (error) {
      // Silently skip files that fail to parse
    }
  }

  return contracts;
}

/**
 * Parses a single Solidity file and extracts custom contract metadata
 * @param filePath Absolute path to the .sol file
 * @returns Custom contract metadata or null if parsing fails
 */
export function parseCustomContract(
  filePath: string,
): CustomContractMetadata | null {
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    const ast = parser.parse(source, {
      loc: false,
      range: true,
    });

    let contractName = '';
    let constructorParams: ParamInfo[] = [];
    let initializeParams: ParamInfo[] = [];
    let contractDocs = {};

    // Visit AST nodes to extract information
    parser.visit(ast, {
      ContractDefinition(node: any) {
        contractName = node.name;
        // Extract contract-level documentation
        contractDocs = extractContractDocs(node, source);
      },

      FunctionDefinition(node: any) {
        // Extract constructor parameters
        if (node.isConstructor) {
          constructorParams = extractFunctionParams(node, source);
        }
        // Extract initialize function parameters
        else if (node.name === 'initialize') {
          initializeParams = extractFunctionParams(node, source);
        }
      },
    });

    if (!contractName) {
      return null;
    }

    if (initializeParams.length === 0) {
      initializeParams = extractInitializeParamsFromArtifact(
        filePath,
        contractName,
      );
    }

    if (!contractName) {
      return null;
    }

    return {
      name: contractName,
      filePath,
      constructorParams,
      initializeParams,
      contractDocs,
    };
  } catch (error) {
    return null;
  }
}

/**
 * Extracts parameters from a function definition along with their NatSpec docs
 */
function extractFunctionParams(functionNode: any, source: string): ParamInfo[] {
  const params: ParamInfo[] = [];

  // Get the comment block before this function
  const commentBlock = getCommentBefore(functionNode, source);
  const paramDocs = parseNatSpecParams(commentBlock);

  // Extract each parameter
  const parameters = functionNode.parameters || [];
  for (const param of parameters) {
    const paramName = param.name;
    const paramType = formatType(param.typeName);

    params.push({
      name: paramName,
      type: paramType,
      description: paramDocs[paramName],
    });
  }

  return params;
}

function extractInitializeParamsFromArtifact(
  filePath: string,
  contractName: string,
): ParamInfo[] {
  try {
    const artifactPath = resolveArtifactPath(filePath, contractName);
    if (!artifactPath) return [];

    const artifact = JSON.parse(
      fs.readFileSync(artifactPath, 'utf8'),
    ) as ContractArtifact;

    const initializeAbi = artifact.abi?.find(
      (entry) => entry.type === 'function' && entry.name === 'initialize',
    );
    if (!initializeAbi?.inputs) return [];

    return initializeAbi.inputs.map((input, index) => ({
      name: input.name && input.name.length > 0 ? input.name : `arg${index}`,
      type: input.type,
    }));
  } catch {
    return [];
  }
}

function resolveArtifactPath(
  filePath: string,
  contractName: string,
): string | null {
  const contractsDir = findAncestorDir(filePath, 'contracts');
  if (!contractsDir) return null;

  const solidityDir = path.dirname(contractsDir);
  const relativePath = path.relative(contractsDir, filePath);

  const artifactPath = path.join(
    solidityDir,
    'artifacts',
    'contracts',
    relativePath,
    `${contractName}.json`,
  );

  return fs.existsSync(artifactPath) ? artifactPath : null;
}

function findAncestorDir(filePath: string, dirName: string): string | null {
  let current = path.dirname(filePath);
  const root = path.parse(current).root;

  while (current && current !== root) {
    if (path.basename(current) === dirName) {
      return current;
    }
    current = path.dirname(current);
  }

  if (path.basename(current) === dirName) {
    return current;
  }

  return null;
}

/**
 * Extracts contract-level documentation
 */
function extractContractDocs(
  contractNode: any,
  source: string,
): { title?: string; notice?: string; dev?: string } {
  const commentBlock = getCommentBefore(contractNode, source);
  const docs: any = {};

  if (!commentBlock) return docs;

  // Clean up comment block for easier parsing
  const cleaned = commentBlock
    .replace(/\/\*\*|\*\/|\/\/\//g, '')
    .replace(/^\s*\*/gm, '')
    .trim();

  // Extract @title (can be multiline but usually isn't)
  const titleMatch = cleaned.match(/@title\s+(.+?)(?=@|\n\n|$)/s);
  if (titleMatch) {
    docs.title = titleMatch[1].trim().replace(/\n\s*/g, ' ');
  }

  // Extract @notice (can span multiple lines)
  const noticeMatch = cleaned.match(/@notice\s+([\s\S]+?)(?=@|$)/);
  if (noticeMatch) {
    docs.notice = noticeMatch[1]
      .trim()
      .replace(/\n\s*/g, ' ')
      .replace(/\s+/g, ' ');
  }

  // Extract @dev (can span multiple lines)
  const devMatch = cleaned.match(/@dev\s+([\s\S]+?)(?=@|$)/);
  if (devMatch) {
    docs.dev = devMatch[1].trim().replace(/\n\s*/g, ' ').replace(/\s+/g, ' ');
  }

  return docs;
}

/**
 * Gets the comment block immediately before a node
 */
function getCommentBefore(node: any, source: string): string {
  if (!node.range) return '';

  const beforeCode = source.substring(0, node.range[0]);

  // Match multi-line comments (/** ... */) with optional whitespace after
  const multiLineMatch = beforeCode.match(/(\/\*\*[\s\S]*?\*\/)\s*$/);
  if (multiLineMatch) {
    return multiLineMatch[1];
  }

  // Match single-line comments (/// ...) with optional whitespace after
  const singleLineMatch = beforeCode.match(/((?:\/\/\/.*\n)+)\s*$/);
  if (singleLineMatch) {
    return singleLineMatch[1];
  }

  return '';
}

/**
 * Parses NatSpec comments to extract @param documentation
 */
function parseNatSpecParams(comment: string): Record<string, string> {
  const params: Record<string, string> = {};

  if (!comment) return params;

  // Clean up the comment
  const cleaned = comment
    .replace(/\/\*\*|\*\/|\/\/\//g, '') // Remove comment markers
    .replace(/^\s*\*/gm, '') // Remove leading asterisks
    .trim();

  // Match @param declarations
  // Format: @param paramName Description text
  const paramRegex = /@param\s+(\w+)\s+(.+?)(?=@|\n\n|$)/gs;

  let match;
  while ((match = paramRegex.exec(cleaned)) !== null) {
    const paramName = match[1].trim();
    const description = match[2].trim().replace(/\n\s*/g, ' ');
    params[paramName] = description;
  }

  return params;
}

/**
 * Formats a Solidity type into a string representation
 */
function formatType(typeName: any): string {
  if (!typeName) return 'unknown';
  if (typeof typeName === 'string') return typeName;

  switch (typeName.type) {
    case 'ElementaryTypeName':
      return typeName.name;

    case 'UserDefinedTypeName':
      return typeName.namePath;

    case 'ArrayTypeName':
      return `${formatType(typeName.baseTypeName)}[]`;

    case 'Mapping':
      return `mapping(${formatType(typeName.keyType)} => ${formatType(typeName.valueType)})`;

    default:
      return 'unknown';
  }
}

/**
 * Converts a Solidity type to a TypeScript/Zod type hint
 * Useful for generating better prompts
 */
export function solidityTypeToHint(solidityType: string): string {
  if (solidityType.startsWith('uint') || solidityType.startsWith('int')) {
    return 'number';
  }
  if (solidityType === 'address') {
    return 'address (0x...)';
  }
  if (solidityType === 'bool') {
    return 'boolean (true/false)';
  }
  if (solidityType === 'string') {
    return 'string';
  }
  if (solidityType === 'bytes' || solidityType.startsWith('bytes')) {
    return 'hex string (0x...)';
  }
  if (solidityType.endsWith('[]')) {
    return 'array (comma-separated)';
  }
  return solidityType;
}
