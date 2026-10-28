package main

import (
	"gorm.io/gorm"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/service"
)

// Service initialization installs projection guards on a new GORM session.
// Every later route, runner and model worker must share that guarded handle;
// the original pool handle is not the managed runtime's DB identity.
func newRuntimeService(repo *repository.Repository, dataDir string) (*service.Service, *gorm.DB) {
	svc := service.New(repo, dataDir)
	return svc, repo.DB()
}
