package cdn

import (
	"context"
	"time"

	"github.com/ovh/cds/engine/api"
	"github.com/ovh/cds/engine/service"
	"github.com/ovh/cds/engine/websocket"
	"github.com/ovh/cds/sdk"
	"github.com/ovh/cds/sdk/log"
	"github.com/ovh/cds/sdk/telemetry"
)

func (s *Service) initRouter(ctx context.Context) error {
	r := s.Router
	r.Background = ctx
	r.URL = s.Cfg.URL
	r.SetHeaderFunc = api.DefaultHeaders
	r.Middlewares = append(r.Middlewares, service.CheckRequestSignatureMiddleware(s.ParsedAPIPublicKey))

	log.Info(r.Background, "Initializing WS server")
	s.WSServer = &websocketServer{
		server:     websocket.NewServer(),
		clientData: make(map[string]*websocketClientData),
	}
	tickerMetrics := time.NewTicker(10 * time.Second)
	defer tickerMetrics.Stop()
	s.GoRoutines.Run(r.Background, "cdn.initRouter.WSServer", func(ctx context.Context) {
		for {
			select {
			case <-tickerMetrics.C:
				telemetry.Record(r.Background, metricsWSClients, int64(len(s.WSServer.server.ClientIDs())))
			case <-ctx.Done():
				telemetry.Record(r.Background, metricsWSClients, 0)
				return
			}
		}
	})

	log.Info(r.Background, "Initializing WS events broker")
	pubSub, err := s.Cache.Subscribe("cdn_events_pubsub")
	if err != nil {
		return sdk.WrapError(err, "unable to subscribe to events_pubsub")
	}
	s.WSBroker = websocket.NewBroker()
	s.WSBroker.OnMessage(func(m []byte) {
		telemetry.Record(r.Background, metricsWSEvents, 1)
		// TODO process message
	})
	s.WSBroker.Init(r.Background, s.GoRoutines, pubSub)

	r.Handle("/mon/version", nil, r.GET(api.VersionHandler, api.Auth(false)))
	r.Handle("/mon/status", nil, r.GET(s.statusHandler, api.Auth(false)))
	r.Handle("/mon/metrics", nil, r.GET(service.GetPrometheustMetricsHandler(s), api.Auth(false)))
	r.Handle("/mon/metrics/all", nil, r.GET(service.GetMetricsHandler, api.Auth(false)))

	r.Handle("/item/delete", nil, r.POST(s.markItemToDeleteHandler))
	r.Handle("/cache", nil, r.DELETE(s.deleteCacheHandler))
	r.Handle("/cache/status", nil, r.GET(s.getStatusCacheHandler))

	r.Handle("/item/{type}/{apiRef}", nil, r.GET(s.getItemLogsHandler))
	r.Handle("/item/{type}/{apiRef}/stream", nil, r.GET(s.getItemLogsStreamHandler, api.Auth(false)))
	r.Handle("/item/{type}/{apiRef}/lines", nil, r.GET(s.getItemLogsLinesHandler, api.Auth(false)))
	r.Handle("/item/{type}/{apiRef}/download", nil, r.GET(s.getItemLogsDownloadHandler, api.Auth(false)))
	r.Handle("/size/item/project/{projectKey}", nil, r.GET(s.getSizeByProjectHandler))

	return nil
}
