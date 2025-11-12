import { confirm, input, select } from '@inquirer/prompts';
import { stringify as yamlStringify } from 'yaml';

import {
  ChainMap,
  ChainTechnicalStack,
  CustomContractMetadata,
  DeployedOwnableConfig,
  HypERC20Deployer,
  HypTokenRouterConfig,
  IsmConfig,
  IsmType,
  MailboxClientConfig,
  TokenType,
  WarpCoreConfig,
  WarpCoreConfigSchema,
  WarpRouteDeployConfig,
  WarpRouteDeployConfigMailboxRequired,
  WarpRouteDeployConfigMailboxRequiredSchema,
  WarpRouteDeployConfigSchema,
  discoverCustomContracts,
  isMovableCollateralTokenConfig,
  resolveRouterMapConfig,
  solidityTypeToHint,
} from '@hyperlane-xyz/sdk';
import { Address, assert, objMap, promiseObjAll } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import { errorRed, log, logBlue, logGreen } from '../logger.js';
import { runMultiChainSelectionStep } from '../utils/chains.js';
import {
  indentYamlOrJson,
  isFile,
  readYamlOrJson,
  writeYamlOrJson,
} from '../utils/files.js';
import {
  detectAndConfirmOrPrompt,
  getWarpRouteIdFromWarpDeployConfig,
  setProxyAdminConfig,
} from '../utils/input.js';
import { useProvidedWarpRouteIdOrPrompt } from '../utils/warp.js';

import { createAdvancedIsmConfig } from './ism.js';

const TYPE_DESCRIPTIONS: Partial<Record<TokenType, string>> = {
  [TokenType.synthetic]: 'A new ERC20 with remote transfer functionality',
  [TokenType.syntheticRebase]: `A rebasing ERC20 with remote transfer functionality. Must be paired with ${TokenType.collateralVaultRebase}`,
  [TokenType.collateral]:
    'Extends an existing ERC20 with remote transfer functionality',
  [TokenType.collateralCctp]:
    'A collateral token that can be transferred via CCTP',
  [TokenType.native]:
    'Extends the native token with remote transfer functionality',
  [TokenType.collateralVault]:
    'Extends an existing ERC4626 with remote transfer functionality. Yields are manually claimed by owner.',
  [TokenType.collateralVaultRebase]:
    'Extends an existing ERC4626 with remote transfer functionality. Rebases yields to token holders.',
  [TokenType.collateralFiat]:
    'Extends an existing FiatToken with remote transfer functionality',
  [TokenType.XERC20]:
    'Extends an existing xERC20 with Warp Route functionality',
  [TokenType.XERC20Lockbox]:
    'Extends an existing xERC20 Lockbox with Warp Route functionality',
  [TokenType.nativeOpL2]: 'An OP L2 native ETH token',
  [TokenType.nativeOpL1]: 'An OP L1 native ETH token',
  [TokenType.collateralEverclear]:
    'A collateral token that can be transferred via Everclear intents',
  [TokenType.ethEverclear]:
    'An ETH token that can be transferred via Everclear intents',
  // TODO: describe
  [TokenType.syntheticUri]: '',
  [TokenType.collateralUri]: '',
  [TokenType.nativeScaled]: '',
};

const TYPE_CHOICES = Object.values(TokenType).map((type) => ({
  name: type,
  value: type,
  description: TYPE_DESCRIPTIONS[type],
}));

export async function fillDefaults(
  context: CommandContext,
  config: ChainMap<Partial<MailboxClientConfig>>,
): Promise<ChainMap<MailboxClientConfig>> {
  return promiseObjAll(
    objMap(config, async (chain, config): Promise<MailboxClientConfig> => {
      let mailbox = config.mailbox;
      if (!mailbox) {
        const addresses = await context.registry.getChainAddresses(chain);
        assert(addresses, `No addresses found for chain ${chain}`);
        mailbox = addresses.mailbox;
      }
      let owner = config.owner;
      if (!owner) {
        owner =
          context.signerAddress ??
          (await context.multiProvider.getSignerAddress(chain));
      }
      return {
        owner,
        mailbox,
        ...config,
      };
    }),
  );
}

export async function readWarpRouteDeployConfig({
  context,
  ...args
}:
  | {
      context: CommandContext;
      warpRouteId: string;
    }
  | {
      context: CommandContext;
      filePath: string;
    }): Promise<WarpRouteDeployConfigMailboxRequired> {
  let config =
    'filePath' in args
      ? readYamlOrJson(args.filePath)
      : await context.registry.getWarpDeployConfig(args.warpRouteId);

  assert(config, `No warp route deploy config found!`);

  config = await fillDefaults(context, config as any);

  config = objMap(
    config as any,
    (_chain, chainConfig: HypTokenRouterConfig) => {
      if (chainConfig.destinationGas) {
        chainConfig.destinationGas = resolveRouterMapConfig(
          context.multiProvider,
          chainConfig.destinationGas,
        );
      }

      if (chainConfig.remoteRouters) {
        chainConfig.remoteRouters = resolveRouterMapConfig(
          context.multiProvider,
          chainConfig.remoteRouters,
        );
      }

      if (!isMovableCollateralTokenConfig(chainConfig)) {
        return chainConfig;
      }

      if (chainConfig.allowedRebalancingBridges) {
        chainConfig.allowedRebalancingBridges = resolveRouterMapConfig(
          context.multiProvider,
          chainConfig.allowedRebalancingBridges,
        );
      }

      return chainConfig;
    },
  );

  //fillDefaults would have added a mailbox to the config if it was missing
  return WarpRouteDeployConfigMailboxRequiredSchema.parse(config);
}

export function isValidWarpRouteDeployConfig(config: any) {
  return WarpRouteDeployConfigSchema.safeParse(config).success;
}

export async function createWarpRouteDeployConfig({
  context,
  outPath,
  advanced = false,
}: {
  context: CommandContext;
  outPath?: string;
  advanced: boolean;
}) {
  logBlue('Creating a new warp route deployment config...');

  const warpChains = await runMultiChainSelectionStep({
    chainMetadata: context.chainMetadata,
    message: 'Select chains to connect',
    requireNumber: 1,
    // If the user supplied the --yes flag we skip asking selection
    // confirmation
    requiresConfirmation: !context.skipConfirmation,
  });

  // Discover custom contracts
  const customContracts = await discoverCustomContracts();

  // Add custom contracts to type choices
  const customChoices = customContracts.map((c: CustomContractMetadata) => ({
    name: c.name as any,
    value: c.name,
    description:
      c.contractDocs.notice ||
      c.contractDocs.title ||
      `Custom contract: ${c.name}`,
  }));

  const result: WarpRouteDeployConfig = {};
  let typeChoices = [...TYPE_CHOICES, ...customChoices];
  for (const chain of warpChains) {
    logBlue(`${chain}: Configuring warp route...`);
    const owner = await detectAndConfirmOrPrompt(
      async () => context.signerAddress,
      'Enter the desired',
      'owner address',
      'signer',
    );

    const proxyAdmin: DeployedOwnableConfig | undefined =
      await setProxyAdminConfig(context, chain);

    const excludeStaticIsms =
      context.multiProvider.getChainMetadata(chain).technicalStack ===
      ChainTechnicalStack.ZkSync;

    /**
     * The logic from the cli is as follows:
     *  --yes flag is provided: set ism to undefined (default ISM config)
     *  --advanced flag is provided: the user will have to build their own configuration using the available ISM types
     *  -- no flag is provided: the user must choose if the default ISM config should be used:
     *    - yes: the default ISM config will be used (Trusted ISM + Default fallback ISM)
     *    - no: keep ism as undefined (default ISM config)
     */
    let interchainSecurityModule: IsmConfig | undefined;
    if (context.skipConfirmation) {
      interchainSecurityModule = undefined;
    } else if (advanced) {
      interchainSecurityModule = await createAdvancedIsmConfig(
        context,
        excludeStaticIsms,
      );
    } else if (
      await confirm({
        message: 'Do you want to use a trusted ISM for warp route?',
      })
    ) {
      interchainSecurityModule = createDefaultWarpIsmConfig(
        owner,
        excludeStaticIsms,
      );
    }

    const type = await select({
      message: `Select ${chain}'s token type`,
      choices: typeChoices,
    });

    switch (type) {
      case TokenType.collateral:
      case TokenType.XERC20:
      case TokenType.XERC20Lockbox:
      case TokenType.collateralFiat:
        result[chain] = {
          type,
          owner,
          proxyAdmin,
          interchainSecurityModule,
          token: await input({
            message: `Enter the existing token address on chain ${chain}`,
          }),
        };
        break;
      case TokenType.collateralUri:
        result[chain] = {
          type,
          owner,
          proxyAdmin,
          isNft: true,
          interchainSecurityModule,
          token: await input({
            message: `Enter the existing token address on chain ${chain}`,
          }),
        };
        break;
      case TokenType.syntheticRebase:
        result[chain] = {
          type,
          owner,
          proxyAdmin,
          collateralChainName: '', // This will be derived correctly by zod.parse() below
          interchainSecurityModule,
        };
        typeChoices = restrictChoices([
          TokenType.syntheticRebase,
          TokenType.collateralVaultRebase,
        ]);
        break;
      case TokenType.collateralVaultRebase:
        result[chain] = {
          type,
          owner,
          proxyAdmin,
          interchainSecurityModule,
          token: await input({
            message: `Enter the ERC-4626 vault address on chain ${chain}`,
          }),
        };

        typeChoices = restrictChoices([TokenType.syntheticRebase]);
        break;
      case TokenType.collateralVault:
        result[chain] = {
          type,
          owner,
          proxyAdmin,
          interchainSecurityModule,
          token: await input({
            message: `Enter the ERC-4626 vault address on chain ${chain}`,
          }),
        };
        break;
      case TokenType.syntheticUri:
        result[chain] = {
          type,
          owner,
          proxyAdmin,
          interchainSecurityModule,
          isNft: true,
        };
        break;
      case TokenType.native:
      case TokenType.synthetic:
        result[chain] = {
          type,
          owner,
          proxyAdmin,
          interchainSecurityModule,
          isNft: false,
        };
        break;
      default:
        // Handle custom contract types
        const customContract = customContracts.find(
          (c: CustomContractMetadata) => c.name === type,
        );

        if (customContract) {
          const customConfig: any = {
            type,
            owner,
            proxyAdmin,
            interchainSecurityModule,
          };

          // Prompt for token metadata (required for custom contracts)
          customConfig.originTokenName = await input({
            message: 'Enter the origin token name:',
          });

          customConfig.originTokenSymbol = await input({
            message: 'Enter the origin token symbol:',
          });

          const decimalsInput = await input({
            message: 'Enter the origin token decimals:',
            default: '18',
          });
          customConfig.originTokenDecimals = parseInt(decimalsInput, 10);

          // Prompt for initial supply
          const initialSupplyInput = await input({
            message: 'Enter the initial token supply (in wei):',
            default: '0',
          });
          customConfig.totalSupply = initialSupplyInput;

          // Prompt for constructor parameters (excluding standard ones)
          const standardParams = new Set([
            '_decimals',
            '_mailbox',
            'decimals',
            'mailbox',
          ]);
          for (const param of customContract.constructorParams) {
            if (!standardParams.has(param.name)) {
              const configKey = param.name.startsWith('_')
                ? param.name.slice(1)
                : param.name;

              const typeHint = solidityTypeToHint(param.type);
              const description = param.description || param.name;

              customConfig[configKey] = await input({
                message: `${description} (${typeHint}):`,
              });
            }
          }

          // Prompt for initialize parameters (excluding standard ones)
          const standardInitParams = new Set([
            '_totalSupply',
            '_initialSupply',
            '_name',
            '_symbol',
            '_hook',
            '_interchainSecurityModule',
            '_ism',
            '_owner',
            'totalSupply',
            'initialSupply',
            'name',
            'symbol',
            'hook',
            'interchainSecurityModule',
            'ism',
            'owner',
          ]);

          for (const param of customContract.initializeParams) {
            if (!standardInitParams.has(param.name)) {
              const configKey = param.name.startsWith('_')
                ? param.name.slice(1)
                : param.name;

              // Skip if already added from constructor
              if (!customConfig[configKey]) {
                const typeHint = solidityTypeToHint(param.type);
                const description = param.description || param.name;

                customConfig[configKey] = await input({
                  message: `${description} (${typeHint}):`,
                });
              }
            }
          }

          result[chain] = customConfig;
        } else {
          throw new Error(`Token type ${type} is not supported`);
        }
    }
  }

  try {
    const warpRouteDeployConfig = WarpRouteDeployConfigSchema.parse(result);
    logBlue(`Warp Route config is valid, writing to file ${outPath}:\n`);
    log(indentYamlOrJson(yamlStringify(warpRouteDeployConfig, null, 2), 4));
    if (outPath) {
      writeYamlOrJson(outPath, warpRouteDeployConfig, 'yaml');
    } else {
      const tokenMetadata = await HypERC20Deployer.deriveTokenMetadata(
        context.multiProvider,
        warpRouteDeployConfig,
      );
      const symbol: string = tokenMetadata.getDefaultSymbol();

      let warpRouteId;
      if (!context.skipConfirmation) {
        warpRouteId = await getWarpRouteIdFromWarpDeployConfig(
          context.registry,
          warpRouteDeployConfig,
          symbol,
        );
      }

      await context.registry.addWarpRouteConfig(warpRouteDeployConfig, {
        symbol,
        warpRouteId, // Will default to SYMBOL/chain1 if `undefined`
      });
      logGreen(
        `✅ Successfully created new warp route deployment config with warp route id: ${warpRouteId}`,
      );
    }
  } catch (e) {
    errorRed(
      `Warp route deployment config is invalid, please see https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/typescript/cli/examples/warp-route-deployment.yaml for an example.`,
    );
    throw e;
  }
}

function restrictChoices(typeChoices: TokenType[]) {
  return TYPE_CHOICES.filter((choice) => typeChoices.includes(choice.name));
}

// Note, this is different than the function above which reads a config
// for a DEPLOYMENT. This gets a config for using a warp route (aka WarpCoreConfig)
export async function readWarpCoreConfig(
  args:
    | {
        context: CommandContext;
        warpRouteId: string;
      }
    | {
        filePath: string;
      },
): Promise<WarpCoreConfig> {
  let config: WarpCoreConfig | null = null;
  const readWithFilePath = 'filePath' in args;
  if (readWithFilePath) {
    config = readYamlOrJson(args.filePath);
  } else {
    config = await args.context.registry.getWarpRoute(args.warpRouteId);
  }
  assert(
    config,
    `No warp route config found for warp route ${
      readWithFilePath ? args.filePath : args.warpRouteId
    }`,
  );
  return WarpCoreConfigSchema.parse(config);
}

/**
 * Creates a default configuration for an ISM.
 *
 * When excludeStaticIsms is false (default):
 * - Creates an AGGREGATION ISM with TRUSTED_RELAYER and FALLBACK_ROUTING modules
 * - Properties relayer and owner are both set as input owner
 *
 * When excludeStaticIsms is true:
 * - Creates only a TRUSTED_RELAYER ISM (as static ISMs like AGGREGATION are not supported)
 * - Properties relayer is set as input owner
 *
 * @param owner - The address of the owner of the ISM
 * @param excludeStaticIsms - Whether to exclude static ISM types (default: false)
 * @returns The ISM configuration
 */
function createDefaultWarpIsmConfig(
  owner: Address,
  excludeStaticIsms: boolean = false,
): IsmConfig {
  const trustedRelayerModule: IsmConfig = {
    type: IsmType.TRUSTED_RELAYER,
    relayer: owner,
  };

  if (excludeStaticIsms) {
    return trustedRelayerModule;
  }

  return {
    type: IsmType.AGGREGATION,
    modules: [trustedRelayerModule, createFallbackRoutingConfig(owner)],
    threshold: 1,
  };
}

/**
 * Creates a fallback configuration for an ISM with a FALLBACK_ROUTING and the provided `owner`.
 *
 * @param owner - The address of the owner of the ISM.
 * @returns The Fallback Routing ISM configuration.
 */
function createFallbackRoutingConfig(owner: Address): IsmConfig {
  return {
    type: IsmType.FALLBACK_ROUTING,
    domains: {},
    owner,
  };
}

export async function getWarpRouteDeployConfig({
  context,
  warpRouteDeployConfigPath,
  warpRouteId: providedWarpRouteId,
  symbol,
}: {
  context: CommandContext;
  warpRouteDeployConfigPath?: string;
  warpRouteId?: string;
  symbol?: string;
}): Promise<WarpRouteDeployConfigMailboxRequired> {
  let warpDeployConfig: WarpRouteDeployConfigMailboxRequired;

  if (warpRouteDeployConfigPath) {
    assert(
      isFile(warpRouteDeployConfigPath),
      `Warp route deployment config file not found at ${warpRouteDeployConfigPath}`,
    );
    log(`Using warp route deployment config at ${warpRouteDeployConfigPath}`);

    warpDeployConfig = await readWarpRouteDeployConfig({
      context,
      filePath: warpRouteDeployConfigPath,
    });
  } else {
    const warpRouteId = await useProvidedWarpRouteIdOrPrompt({
      warpRouteId: providedWarpRouteId,
      context,
      symbol,
      promptByDeploymentConfigs: true,
    });

    warpDeployConfig = await readWarpRouteDeployConfig({
      context,
      warpRouteId,
    });
  }

  return warpDeployConfig;
}
