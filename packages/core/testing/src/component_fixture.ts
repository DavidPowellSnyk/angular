/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ApplicationRef, ChangeDetectorRef, ComponentRef, DebugElement, ElementRef, getDebugNode, inject, NgZone, RendererFactory2, ViewRef, ɵDeferBlockDetails as DeferBlockDetails, ɵdetectChangesInViewIfRequired, ɵEffectScheduler as EffectScheduler, ɵgetDeferBlocks as getDeferBlocks, ɵNoopNgZone as NoopNgZone, ɵPendingTasks as PendingTasks,} from '@angular/core';
import {Subject, Subscription} from 'rxjs';
import {first} from 'rxjs/operators';

import {DeferBlockFixture} from './defer';
import {AllowDetectChangesAndAcknowledgeItCanHideApplicationBugs, ComponentFixtureAutoDetect, ComponentFixtureNoNgZone,} from './test_bed_common';

/**
 * Fixture for debugging and testing a component.
 *
 * @publicApi
 */
export abstract class ComponentFixture<T> {
  /**
   * The DebugElement associated with the root element of this component.
   */
  debugElement: DebugElement;

  /**
   * The instance of the root component class.
   */
  componentInstance: T;

  /**
   * The native element at the root of the component.
   */
  nativeElement: any;

  /**
   * The ElementRef for the element at the root of the component.
   */
  elementRef: ElementRef;

  /**
   * The ChangeDetectorRef for the component
   */
  changeDetectorRef: ChangeDetectorRef;

  private _renderer: RendererFactory2|null|undefined;
  private _isDestroyed: boolean = false;
  /** @internal */
  protected readonly _noZoneOptionIsSet = inject(ComponentFixtureNoNgZone, {optional: true});
  /** @internal */
  protected _ngZone: NgZone = this._noZoneOptionIsSet ? new NoopNgZone() : inject(NgZone);
  /** @internal */
  protected _effectRunner = inject(EffectScheduler);
  // Inject ApplicationRef to ensure NgZone stableness causes after render hooks to run
  // This will likely happen as a result of fixture.detectChanges because it calls ngZone.run
  // This is a crazy way of doing things but hey, it's the world we live in.
  // The zoneless scheduler should instead do this more imperatively by attaching
  // the `ComponentRef` to `ApplicationRef` and calling `appRef.tick` as the `detectChanges`
  // behavior.
  /** @internal */
  protected readonly _appRef = inject(ApplicationRef);
  /** @internal */
  protected readonly _testAppRef = this._appRef as unknown as TestAppRef;

  // TODO(atscott): Remove this from public API
  ngZone = this._noZoneOptionIsSet ? null : this._ngZone;

  /** @nodoc */
  constructor(public componentRef: ComponentRef<T>) {
    this.changeDetectorRef = componentRef.changeDetectorRef;
    this.elementRef = componentRef.location;
    this.debugElement = <DebugElement>getDebugNode(this.elementRef.nativeElement);
    this.componentInstance = componentRef.instance;
    this.nativeElement = this.elementRef.nativeElement;
    this.componentRef = componentRef;
  }

  /**
   * Trigger a change detection cycle for the component.
   */
  abstract detectChanges(checkNoChanges?: boolean): void;

  /**
   * Do a change detection run to make sure there were no changes.
   */
  checkNoChanges(): void {
    this.changeDetectorRef.checkNoChanges();
  }

  /**
   * Set whether the fixture should autodetect changes.
   *
   * Also runs detectChanges once so that any existing change is detected.
   */
  abstract autoDetectChanges(autoDetect?: boolean): void;

  /**
   * Return whether the fixture is currently stable or has async tasks that have not been completed
   * yet.
   */
  abstract isStable(): boolean;

  /**
   * Get a promise that resolves when the fixture is stable.
   *
   * This can be used to resume testing after events have triggered asynchronous activity or
   * asynchronous change detection.
   */
  abstract whenStable(): Promise<any>;

  /**
   * Retrieves all defer block fixtures in the component fixture.
   *
   * @developerPreview
   */
  getDeferBlocks(): Promise<DeferBlockFixture[]> {
    const deferBlocks: DeferBlockDetails[] = [];
    const lView = (this.componentRef.hostView as any)['_lView'];
    getDeferBlocks(lView, deferBlocks);

    const deferBlockFixtures = [];
    for (const block of deferBlocks) {
      deferBlockFixtures.push(new DeferBlockFixture(block, this));
    }

    return Promise.resolve(deferBlockFixtures);
  }

  private _getRenderer() {
    if (this._renderer === undefined) {
      this._renderer = this.componentRef.injector.get(RendererFactory2, null);
    }
    return this._renderer as RendererFactory2 | null;
  }

  /**
   * Get a promise that resolves when the ui state is stable following animations.
   */
  whenRenderingDone(): Promise<any> {
    const renderer = this._getRenderer();
    if (renderer && renderer.whenRenderingDone) {
      return renderer.whenRenderingDone();
    }
    return this.whenStable();
  }

  /**
   * Trigger component destruction.
   */
  destroy(): void {
    if (!this._isDestroyed) {
      this.componentRef.destroy();
      this._isDestroyed = true;
    }
  }
}

/**
 * ComponentFixture behavior that actually attaches the component to the application to ensure
 * behaviors between fixture and application do not diverge. `detectChanges` is disabled by default
 * (instead, tests should wait for the scheduler to detect changes), `whenStable` is directly the
 * `ApplicationRef.isStable`, and `autoDetectChanges` cannot be disabled.
 */
export class ScheduledComponentFixture<T> extends ComponentFixture<T> {
  private readonly disableDetectChangesError =
      inject(AllowDetectChangesAndAcknowledgeItCanHideApplicationBugs, {optional: true}) ?? false;
  private readonly pendingTasks = inject(PendingTasks);

  initialize(): void {
    this._appRef.attachView(this.componentRef.hostView);
  }

  override detectChanges(checkNoChanges: boolean = true): void {
    if (!this.disableDetectChangesError) {
      throw new Error(
          'Do not use `detectChanges` directly when using zoneless change detection.' +
              ' Instead, wait for the next render or `fixture.whenStable`.',
      );
    } else if (!checkNoChanges) {
      throw new Error(
          'Cannot disable `checkNoChanges` in this configuration. ' +
              'Use `fixture.componentRef.hostView.changeDetectorRef.detectChanges()` instead.',
      );
    }
    this._effectRunner.flush();
    this._appRef.tick();
    this._effectRunner.flush();
  }

  override isStable(): boolean {
    return !this.pendingTasks.hasPendingTasks.value;
  }

  override whenStable(): Promise<boolean> {
    if (this.isStable()) {
      return Promise.resolve(false);
    }
    return this._appRef.isStable.pipe(first((stable) => stable)).toPromise().then(() => true);
  }

  override autoDetectChanges(autoDetect?: boolean|undefined): void {
    throw new Error('Cannot call autoDetectChanges when using change detection scheduling.');
  }
}

interface TestAppRef {
  externalTestViews: Set<ViewRef>;
  beforeRender: Subject<boolean>;
  afterTick: Subject<void>;
}

/**
 * ComponentFixture behavior that attempts to act as a "mini application".
 */
export class PseudoApplicationComponentFixture<T> extends ComponentFixture<T> {
  private _subscriptions = new Subscription();
  private _autoDetect = inject(ComponentFixtureAutoDetect, {optional: true}) ?? false;
  private _isStable: boolean = true;
  private _promise: Promise<boolean>|null = null;
  private _resolve: ((result: boolean) => void)|null = null;
  private afterTickSubscription: Subscription|undefined = undefined;
  private beforeRenderSubscription: Subscription|undefined = undefined;

  initialize(): void {
    if (this._autoDetect) {
      this.subscribeToAppRefEvents();
    }
    this.componentRef.hostView.onDestroy(() => {
      this.unsubscribeFromAppRefEvents();
    });
    // Create subscriptions outside the NgZone so that the callbacks run outside
    // of NgZone.
    this._ngZone.runOutsideAngular(() => {
      this._subscriptions.add(
          this._ngZone.onUnstable.subscribe({
            next: () => {
              this._isStable = false;
            },
          }),
      );
      this._subscriptions.add(
          this._ngZone.onStable.subscribe({
            next: () => {
              this._isStable = true;
              // Check whether there is a pending whenStable() completer to resolve.
              if (this._promise !== null) {
                // If so check whether there are no pending macrotasks before resolving.
                // Do this check in the next tick so that ngZone gets a chance to update the state
                // of pending macrotasks.
                queueMicrotask(() => {
                  if (!this._ngZone.hasPendingMacrotasks) {
                    if (this._promise !== null) {
                      this._resolve!(true);
                      this._resolve = null;
                      this._promise = null;
                    }
                  }
                });
              }
            },
          }),
      );

      this._subscriptions.add(
          this._ngZone.onError.subscribe({
            next: (error: any) => {
              throw error;
            },
          }),
      );
    });
  }

  override detectChanges(checkNoChanges = true): void {
    this._effectRunner.flush();
    // Run the change detection inside the NgZone so that any async tasks as part of the change
    // detection are captured by the zone and can be waited for in isStable.
    this._ngZone.run(() => {
      this.changeDetectorRef.detectChanges();
      if (checkNoChanges) {
        this.checkNoChanges();
      }
    });
    // Run any effects that were created/dirtied during change detection. Such effects might become
    // dirty in response to input signals changing.
    this._effectRunner.flush();
  }

  override isStable(): boolean {
    return this._isStable && !this._ngZone.hasPendingMacrotasks;
  }

  override whenStable(): Promise<boolean> {
    if (this.isStable()) {
      return Promise.resolve(false);
    } else if (this._promise !== null) {
      return this._promise;
    } else {
      this._promise = new Promise((res) => {
        this._resolve = res;
      });
      return this._promise;
    }
  }

  override autoDetectChanges(autoDetect = true): void {
    if (this._noZoneOptionIsSet) {
      throw new Error('Cannot call autoDetectChanges when ComponentFixtureNoNgZone is set.');
    }

    if (autoDetect !== this._autoDetect) {
      if (autoDetect) {
        this.subscribeToAppRefEvents();
      } else {
        this.unsubscribeFromAppRefEvents();
      }
    }

    this._autoDetect = autoDetect;
    this.detectChanges();
  }

  private subscribeToAppRefEvents() {
    this._ngZone.runOutsideAngular(() => {
      this.afterTickSubscription = this._testAppRef.afterTick.subscribe(() => {
        this.checkNoChanges();
      });
      this.beforeRenderSubscription = this._testAppRef.beforeRender.subscribe((isFirstPass) => {
        try {
          if (isFirstPass) {
            // TODO(atscott): This matches old behavior where change detection was forced on every
            // microtask empty, ignoring OnPush. This is incorrect and should be fixed in a major
            // version if possible.
            this.changeDetectorRef.detectChanges();
          } else {
            ɵdetectChangesInViewIfRequired(
                (this.componentRef.hostView as any)._lView,
                isFirstPass,
                (this.componentRef.hostView as any).notifyErrorHandler,
            );
          }

        } catch (e: unknown) {
          // If an error ocurred during change detection, remove the test view from the application
          // ref tracking. Note that this isn't exactly desirable but done this way because of how
          // things used to work with `autoDetect` and uncaught errors. Ideally we would surface
          // this error to the error handler instead and continue refreshing the view like
          // what would happen in the application.
          this.unsubscribeFromAppRefEvents();

          throw e;
        }
      });
      this._testAppRef.externalTestViews.add(this.componentRef.hostView);
    });
  }

  private unsubscribeFromAppRefEvents() {
    this.afterTickSubscription?.unsubscribe();
    this.beforeRenderSubscription?.unsubscribe();
    this.afterTickSubscription = undefined;
    this.beforeRenderSubscription = undefined;
    this._testAppRef.externalTestViews.delete(this.componentRef.hostView);
  }

  override destroy(): void {
    this.unsubscribeFromAppRefEvents();
    this._subscriptions.unsubscribe();
    super.destroy();
  }
}
