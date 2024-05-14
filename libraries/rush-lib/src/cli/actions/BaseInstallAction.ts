// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import type {
  CommandLineFlagParameter,
  CommandLineIntegerParameter,
  IRequiredCommandLineIntegerParameter
} from '@rushstack/ts-command-line';
import { AlreadyReportedError } from '@rushstack/node-core-library';
import { type ITerminal, Colorize } from '@rushstack/terminal';

import { BaseRushAction, type IBaseRushActionOptions } from './BaseRushAction';
import { Event } from '../../api/EventHooks';
import type { BaseInstallManager } from '../../logic/base/BaseInstallManager';
import type { IInstallManagerOptions } from '../../logic/base/BaseInstallManagerTypes';
import { PurgeManager } from '../../logic/PurgeManager';
import { SetupChecks } from '../../logic/SetupChecks';
import { StandardScriptUpdater } from '../../logic/StandardScriptUpdater';
import { Stopwatch } from '../../utilities/Stopwatch';
import { VersionMismatchFinder } from '../../logic/versionMismatch/VersionMismatchFinder';
import { RushConstants } from '../../logic/RushConstants';
import type { SelectionParameterSet } from '../parsing/SelectionParameterSet';
import type { RushConfigurationProject } from '../../api/RushConfigurationProject';
import type { Subspace } from '../../api/Subspace';

interface ISubspaceSelectedProjectsMetadata {
  selectedProjects: Set<RushConfigurationProject>;
  pnpmFilterArguments: string[];
  alwaysFullInstall: boolean;
}

/**
 * This is the common base class for InstallAction and UpdateAction.
 */
export abstract class BaseInstallAction extends BaseRushAction {
  protected readonly _terminal: ITerminal;
  protected readonly _purgeParameter: CommandLineFlagParameter;
  protected readonly _bypassPolicyParameter: CommandLineFlagParameter;
  protected readonly _noLinkParameter: CommandLineFlagParameter;
  protected readonly _networkConcurrencyParameter: CommandLineIntegerParameter;
  protected readonly _debugPackageManagerParameter: CommandLineFlagParameter;
  protected readonly _maxInstallAttempts: IRequiredCommandLineIntegerParameter;
  protected readonly _ignoreHooksParameter: CommandLineFlagParameter;
  protected readonly _offlineParameter: CommandLineFlagParameter;
  /*
   * Subclasses can initialize the _selectionParameters property in order for
   * the parameters to be written to the telemetry file
   */
  protected _selectionParameters?: SelectionParameterSet;

  public constructor(options: IBaseRushActionOptions) {
    super(options);

    this._terminal = options.parser.terminal;

    this._purgeParameter = this.defineFlagParameter({
      parameterLongName: '--purge',
      parameterShortName: '-p',
      description: 'Perform "rush purge" before starting the installation'
    });
    this._bypassPolicyParameter = this.defineFlagParameter({
      parameterLongName: RushConstants.bypassPolicyFlagLongName,
      description: `Overrides enforcement of the "gitPolicy" rules from ${RushConstants.rushJsonFilename} (use honorably!)`
    });
    this._noLinkParameter = this.defineFlagParameter({
      parameterLongName: '--no-link',
      description:
        'If "--no-link" is specified, then project symlinks will NOT be created' +
        ' after the installation completes.  You will need to run "rush link" manually.' +
        ' This flag is useful for automated builds that want to report stages individually' +
        ' or perform extra operations in between the two stages. This flag is not supported' +
        ' when using workspaces.'
    });
    this._networkConcurrencyParameter = this.defineIntegerParameter({
      parameterLongName: '--network-concurrency',
      argumentName: 'COUNT',
      description:
        'If specified, limits the maximum number of concurrent network requests.' +
        '  This is useful when troubleshooting network failures.'
    });
    this._debugPackageManagerParameter = this.defineFlagParameter({
      parameterLongName: '--debug-package-manager',
      description:
        'Activates verbose logging for the package manager. You will probably want to pipe' +
        ' the output of Rush to a file when using this command.'
    });
    this._maxInstallAttempts = this.defineIntegerParameter({
      parameterLongName: '--max-install-attempts',
      argumentName: 'NUMBER',
      description: `Overrides the default maximum number of install attempts.`,
      defaultValue: RushConstants.defaultMaxInstallAttempts
    });
    this._ignoreHooksParameter = this.defineFlagParameter({
      parameterLongName: '--ignore-hooks',
      description:
        `Skips execution of the "eventHooks" scripts defined in ${RushConstants.rushJsonFilename}. ` +
        'Make sure you know what you are skipping.'
    });
    this._offlineParameter = this.defineFlagParameter({
      parameterLongName: '--offline',
      description:
        `Enables installation to be performed without internet access. PNPM will instead report an error` +
        ` if the necessary NPM packages cannot be obtained from the local cache.` +
        ` For details, see the documentation for PNPM's "--offline" parameter.`
    });
  }

  protected abstract buildInstallOptionsAsync(): Promise<IInstallManagerOptions>;

  protected async runAsync(): Promise<void> {
    const installManagerOptions: IInstallManagerOptions = await this.buildInstallOptionsAsync();

    if (this.rushConfiguration._hasVariantsField) {
      this._terminal.writeLine(
        Colorize.yellow(
          `Warning: Please remove the obsolete "variants" field from your ${RushConstants.rushJsonFilename} ` +
            'file. Installation variants have been replaced by the new Rush subspaces feature. ' +
            'In the next major release, Rush will fail to execute if this field is present.'
        )
      );
    }

    // If we are doing a filtered install and subspaces is enabled, we need to find the affected subspaces and install for all of them.
    let selectedSubspaces: Set<Subspace> | undefined;
    const selectedProjectsMetadataBySubspace: Map<Subspace, ISubspaceSelectedProjectsMetadata> = new Map();
    if (this.rushConfiguration.subspacesFeatureEnabled) {
      const selectedSubspaceParameter: Subspace | undefined = this._selectionParameters?.getTargetSubspace();
      selectedSubspaces = new Set();
      const { selectedProjects } = installManagerOptions;
      if (selectedProjects.size !== this.rushConfiguration.projects.length) {
        // This is a filtered install. Go through each project, add its subspace's pnpm filter arguments
        for (const project of selectedProjects) {
          const { subspace: projectSubspace } = project;
          let subspaceSelectedProjectsMetadata: ISubspaceSelectedProjectsMetadata | undefined =
            selectedProjectsMetadataBySubspace.get(projectSubspace);
          if (!subspaceSelectedProjectsMetadata) {
            selectedSubspaces.add(projectSubspace);
            const alwaysFullInstall: boolean = projectSubspace.getPnpmOptions()?.alwaysFullInstall ?? false;
            subspaceSelectedProjectsMetadata = {
              selectedProjects: new Set(alwaysFullInstall ? projectSubspace.getProjects() : undefined),
              pnpmFilterArguments: [],
              alwaysFullInstall
            };
            selectedProjectsMetadataBySubspace.set(projectSubspace, subspaceSelectedProjectsMetadata);
          }

          const {
            pnpmFilterArguments,
            selectedProjects: subspaceSelectedProjects,
            alwaysFullInstall
          } = subspaceSelectedProjectsMetadata;
          if (!alwaysFullInstall) {
            subspaceSelectedProjects.add(project);
            pnpmFilterArguments.push('--filter', project.packageName);
          }
        }
      } else if (selectedSubspaceParameter) {
        // Selecting a single subspace
        selectedSubspaces = new Set<Subspace>([selectedSubspaceParameter]);
      } else {
        // Selecting all subspaces if preventSelectingAllSubspaces is not enabled in subspaces.json
        if (!this.rushConfiguration.subspacesConfiguration?.preventSelectingAllSubspaces) {
          selectedSubspaces = new Set<Subspace>(this.rushConfiguration.subspaces);
        } else {
          // eslint-disable-next-line no-console
          console.log();
          // eslint-disable-next-line no-console
          console.log(
            Colorize.red(
              `The subspaces preventSelectingAllSubspaces configuration is enabled, which enforces installation for a specified set of subspace,` +
                ` passed by the "--subspace" parameter or selected from targeted projects using any project selector.`
            )
          );
          throw new AlreadyReportedError();
        }
      }
    }

    if (selectedSubspaces) {
      // Check each subspace for version inconsistencies
      for (const subspace of selectedSubspaces) {
        VersionMismatchFinder.ensureConsistentVersions(this.rushConfiguration, this._terminal, {
          subspace
        });
      }
    } else {
      VersionMismatchFinder.ensureConsistentVersions(this.rushConfiguration, this._terminal);
    }

    const stopwatch: Stopwatch = Stopwatch.start();

    SetupChecks.validate(this.rushConfiguration);
    let warnAboutScriptUpdate: boolean = false;
    if (this.actionName === 'update') {
      warnAboutScriptUpdate = await StandardScriptUpdater.updateAsync(this.rushConfiguration);
    } else {
      await StandardScriptUpdater.validateAsync(this.rushConfiguration);
    }

    this.eventHooksManager.handle(
      Event.preRushInstall,
      this.parser.isDebug,
      this._ignoreHooksParameter.value
    );

    const purgeManager: PurgeManager = new PurgeManager(this.rushConfiguration, this.rushGlobalFolder);

    if (this._purgeParameter.value!) {
      // eslint-disable-next-line no-console
      console.log('The --purge flag was specified, so performing "rush purge"');
      purgeManager.purgeNormal();
      // eslint-disable-next-line no-console
      console.log('');
    }

    if (this._networkConcurrencyParameter.value) {
      if (this.rushConfiguration.packageManager !== 'pnpm') {
        throw new Error(
          `The "${this._networkConcurrencyParameter.longName}" parameter is` +
            ` only supported when using the PNPM package manager.`
        );
      }
    }

    if (this._maxInstallAttempts.value < 1) {
      throw new Error(`The value of "${this._maxInstallAttempts.longName}" must be positive and nonzero.`);
    }

    const installManagerFactoryModule: typeof import('../../logic/InstallManagerFactory') = await import(
      /* webpackChunkName: 'InstallManagerFactory' */
      '../../logic/InstallManagerFactory'
    );
    let installSuccessful: boolean = true;

    try {
      if (selectedSubspaces) {
        // Run the install for each affected subspace
        for (const subspace of selectedSubspaces) {
          const selectedProjectsMetadata: ISubspaceSelectedProjectsMetadata | undefined =
            selectedProjectsMetadataBySubspace.get(subspace);
          // eslint-disable-next-line no-console
          console.log(Colorize.green(`Installing for subspace: ${subspace.subspaceName}`));
          let installManagerOptionsForInstall: IInstallManagerOptions;
          if (selectedProjectsMetadata) {
            const { selectedProjects, pnpmFilterArguments } = selectedProjectsMetadata;
            installManagerOptionsForInstall = {
              ...installManagerOptions,
              selectedProjects,
              pnpmFilterArguments,
              subspace
            };
          } else {
            installManagerOptionsForInstall = {
              ...installManagerOptions,
              subspace
            };
          }

          await this._doInstall(installManagerFactoryModule, purgeManager, installManagerOptionsForInstall);
        }
      } else {
        await this._doInstall(installManagerFactoryModule, purgeManager, installManagerOptions);
      }
    } catch (error) {
      installSuccessful = false;
      throw error;
    } finally {
      await purgeManager.startDeleteAllAsync();
      stopwatch.stop();

      this._collectTelemetry(stopwatch, installManagerOptions, installSuccessful);
      this.parser.flushTelemetry();
      this.eventHooksManager.handle(
        Event.postRushInstall,
        this.parser.isDebug,
        this._ignoreHooksParameter.value
      );
    }

    if (warnAboutScriptUpdate) {
      // eslint-disable-next-line no-console
      console.log(
        '\n' +
          Colorize.yellow(
            'Rush refreshed some files in the "common/scripts" folder.' +
              '  Please commit this change to Git.'
          )
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n' + Colorize.green(`Rush ${this.actionName} finished successfully. (${stopwatch.toString()})`)
    );
  }

  private async _doInstall(
    installManagerFactoryModule: typeof import('../../logic/InstallManagerFactory'),
    purgeManager: PurgeManager,
    installManagerOptions: IInstallManagerOptions
  ): Promise<void> {
    const installManager: BaseInstallManager =
      await installManagerFactoryModule.InstallManagerFactory.getInstallManagerAsync(
        this.rushConfiguration,
        this.rushGlobalFolder,
        purgeManager,
        installManagerOptions
      );

    await installManager.doInstallAsync();
  }

  private _collectTelemetry(
    stopwatch: Stopwatch,
    installManagerOptions: IInstallManagerOptions,
    success: boolean
  ): void {
    if (this.parser.telemetry) {
      const extraData: Record<string, string> = {
        mode: this.actionName,
        clean: (!!this._purgeParameter.value).toString(),
        debug: installManagerOptions.debug.toString(),
        full: installManagerOptions.fullUpgrade.toString(),
        ...this.getParameterStringMap(),
        ...this._selectionParameters?.getTelemetry()
      };
      this.parser.telemetry.log({
        name: 'install',
        durationInSeconds: stopwatch.duration,
        result: success ? 'Succeeded' : 'Failed',
        extraData
      });
    }
  }
}
