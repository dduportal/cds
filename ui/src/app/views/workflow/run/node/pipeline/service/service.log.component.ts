import { HttpClient, HttpHeaders } from '@angular/common/http';
import {
    ChangeDetectionStrategy,
    ChangeDetectorRef,
    Component,
    ElementRef,
    Input,
    NgZone,
    OnDestroy,
    OnInit,
    ViewChild
} from '@angular/core';
import { Select, Store } from '@ngxs/store';
import * as AU from 'ansi_up';
import { CDNLogAccess, PipelineStatus, ServiceLog } from 'app/model/pipeline.model';
import { WorkflowNodeJobRun } from 'app/model/workflow.run.model';
import { WorkflowService } from 'app/service/workflow/workflow.service';
import { AutoUnsubscribe } from 'app/shared/decorator/autoUnsubscribe';
import { FeatureState } from 'app/store/feature.state';
import { ProjectState } from 'app/store/project.state';
import { WorkflowState, WorkflowStateModel } from 'app/store/workflow.state';
import { Observable, Subscription } from 'rxjs';

@Component({
    selector: 'app-workflow-service-log',
    templateUrl: './service.log.html',
    styleUrls: ['service.log.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush
})
@AutoUnsubscribe()
export class WorkflowServiceLogComponent implements OnInit, OnDestroy {
    @Select(WorkflowState.getSelectedWorkflowNodeJobRun()) nodeJobRun$: Observable<WorkflowNodeJobRun>;
    nodeJobRunSubs: Subscription;

    @ViewChild('logsContent') logsElt: ElementRef;

    @Input() serviceName: string;

    logsSplitted: Array<string> = [];
    serviceLog: ServiceLog;

    pollingSubscription: Subscription;

    currentRunJobID: number;
    currentRunJobStatus: string;

    showLog = {};
    loading = true;
    zone: NgZone;

    ansi_up = new AU.default;

    constructor(
        private _store: Store,
        private _cd: ChangeDetectorRef,
        private _ngZone: NgZone,
        private _workflowService: WorkflowService,
        private _http: HttpClient
    ) {
        this.zone = new NgZone({ enableLongStackTrace: false });
    }

    ngOnDestroy(): void { } // Should be set to use @AutoUnsubscribe with AOT

    ngOnInit(): void {
        this.nodeJobRunSubs = this.nodeJobRun$.subscribe(njr => {
            if (!njr) {
                this.stopPolling();
                return
            }
            if (this.currentRunJobID && njr.id === this.currentRunJobID && this.currentRunJobStatus === njr.status) {
                return;
            }

            let invalidServiceName = !njr.job.action.requirements.find(r => r.type === 'service' && r.name === this.serviceName);
            if (invalidServiceName) {
                return;
            }

            this.currentRunJobID = njr.id;
            this.currentRunJobStatus = njr.status;
            if (!this.pollingSubscription) {
                this.initWorker();
            }
            this._cd.markForCheck();
        });
    }

    getLogs(serviceLog: ServiceLog) {
        if (serviceLog && serviceLog.val) {
            return this.ansi_up.ansi_to_html(serviceLog.val);
        }
        return '';
    }

    async initWorker() {
        if (!this.serviceLog) {
            this.loading = true;
        }

        let projectKey = this._store.selectSnapshot(ProjectState.projectSnapshot).key;
        let workflowName = this._store.selectSnapshot(WorkflowState.workflowSnapshot).name;
        let runNumber = (<WorkflowStateModel>this._store.selectSnapshot(WorkflowState)).workflowNodeRun.num;
        let nodeRunId = (<WorkflowStateModel>this._store.selectSnapshot(WorkflowState)).workflowNodeRun.id;
        let runJobId = this.currentRunJobID;

        const cdnEnabled = !!this._store.selectSnapshot(FeatureState.feature('cdn-job-logs')).find(f => {
            return !!f.results.find(r => r.enabled && r.paramString === JSON.stringify({ 'project_key': projectKey }));
        });

        let logAccess: CDNLogAccess;
        if (cdnEnabled) {
            logAccess = await this._workflowService.getServiceAccess(projectKey, workflowName, nodeRunId, runJobId,
                this.serviceName).toPromise();
        }

        let callback = (serviceLog: ServiceLog) => {
            this.serviceLog = serviceLog;
            this.logsSplitted = this.getLogs(serviceLog).split('\n');
            if (this.loading) {
                this.loading = false;
            }
            this._cd.markForCheck();
        };

        if (!cdnEnabled || !logAccess.exists) {
            const serviceLog = await this._workflowService.getServiceLog(projectKey, workflowName,
                nodeRunId, runJobId, this.serviceName).toPromise();
            callback(serviceLog);
        } else {
            const data = await this._http.get('./cdscdn' + logAccess.download_path, {
                responseType: 'text',
                headers: new HttpHeaders({ 'Authorization': `Bearer ${logAccess.token}` })
            }).toPromise();
            callback(<ServiceLog>{ val: data });
        }

        if (this.currentRunJobStatus === PipelineStatus.SUCCESS
            || this.currentRunJobStatus === PipelineStatus.FAIL
            || this.currentRunJobStatus === PipelineStatus.STOPPED) {
            return;
        }

        this.stopPolling();
        this._ngZone.runOutsideAngular(() => {
            this.pollingSubscription = Observable.interval(2000)
                .mergeMap(_ => {
                    if (!cdnEnabled || !logAccess.exists) {
                        return this._workflowService.getServiceLog(projectKey, workflowName, nodeRunId,
                            runJobId, this.serviceName);
                    }
                    return this._http.get('./cdscdn' + logAccess.download_path, {
                        responseType: 'text',
                        headers: new HttpHeaders({ 'Authorization': `Bearer ${logAccess.token}` })
                    }).map(data => <ServiceLog>{ val: data });
                })
                .subscribe(serviceLogs => {
                    this.zone.run(() => {
                        callback(serviceLogs);
                        if (this.currentRunJobStatus === PipelineStatus.SUCCESS
                            || this.currentRunJobStatus === PipelineStatus.FAIL
                            || this.currentRunJobStatus === PipelineStatus.STOPPED) {
                            this.stopPolling();
                        }
                    });
                });
        });
    }

    stopPolling() {
        if (this.pollingSubscription) {
            this.pollingSubscription.unsubscribe();
        }
    }

    copyRawLog(serviceLog) {
        this.logsElt.nativeElement.value = serviceLog.val;
        this.logsElt.nativeElement.select();
        document.execCommand('copy');
    }
}
