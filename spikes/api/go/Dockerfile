FROM golang:1.26.3-bookworm@sha256:386d475a660466863d9f8c766fec64d7fdad3edac2c6a05020c09534d71edb4b AS build
WORKDIR /src
COPY spikes/api/go/go.mod spikes/api/go/go.sum ./
RUN go mod download
COPY spikes/api/go/main.go ./
RUN go vet ./... && CGO_ENABLED=0 go build -trimpath -o /api .
FROM gcr.io/distroless/static-debian12:nonroot@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab
COPY --from=build /api /api
ENTRYPOINT ["/api"]
