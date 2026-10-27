package app

import (
	"yingce/backend/internal/flow"
	"yingce/backend/internal/repository"
)

func init() {
	flow.RegisterVideoProjectionPurger(repository.PurgeVideoConversationCaches)
}
