package flow

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"time"
)

type videoEmbeddingText struct {
	ChunkID string `json:"chunk_id"`
	Text    string `json:"text"`
	SHA256  string `json:"sha256"`
}

func decodeVideoEmbedding(raw []byte) ([]videoEmbeddingText, error) {
	var input struct {
		Texts []videoEmbeddingText `json:"texts"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&input) != nil || d.Decode(new(any)) != io.EOF || len(input.Texts) < 1 || len(input.Texts) > 32 {
		return nil, ErrInvalid
	}
	seen := map[string]bool{}
	total := 0
	for _, text := range input.Texts {
		hash := sha256.Sum256([]byte(text.Text))
		total += len(text.Text)
		if text.ChunkID == "" || len(text.ChunkID) > 160 || seen[text.ChunkID] || len(text.Text) == 0 || len(text.Text) > 8192 || total > 131072 || text.SHA256 != hex.EncodeToString(hash[:]) {
			return nil, ErrInvalid
		}
		seen[text.ChunkID] = true
	}
	return input.Texts, nil
}

// The embedding route is another operation of the same configured gateway,
// with the same credit reservation, idempotency key and usage sink.
func (g *OpenAICompatGateway) EmbedVideo(ctx context.Context, raw []byte) (string, int64, error) {
	texts, err := decodeVideoEmbedding(raw)
	if err != nil {
		return "", 0, err
	}
	if g.EmbeddingModel == "" || g.EmbeddingMicroPer1KTok <= 0 || g.EmbeddingDimensions < 0 || g.EmbeddingDimensions > 3072 {
		return "", 0, ErrModelNotInSnapshot
	}
	inputs := make([]string, len(texts))
	for i, text := range texts {
		inputs[i] = text.Text
	}
	payload := map[string]any{"model": g.EmbeddingModel, "input": inputs, "encoding_format": "float"}
	if g.EmbeddingDimensions > 0 {
		payload["dimensions"] = g.EmbeddingDimensions
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequestWithContext(ctx, "POST", g.URL+"/embeddings", bytes.NewReader(body))
	if err != nil {
		return "", 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if g.Key != "" {
		req.Header.Set("Authorization", "Bearer "+g.Key)
	}
	if meta, ok := ctx.Value(modelCallMetaCtx{}).(ModelCallMeta); ok {
		req.Header.Set("X-Flow-Reservation-Id", meta.ReservationID)
		req.Header.Set("X-Flow-Price-Version", meta.PriceVersion)
		req.Header.Set("X-Flow-Call-Id", meta.CallID)
	}
	if key, _ := ctx.Value(modelIdemCtx{}).(string); key != "" {
		req.Header.Set("Idempotency-Key", key)
	}
	hc := g.HTTP
	if hc == nil {
		hc = &http.Client{Timeout: 90 * time.Second}
	}
	copyClient := *hc
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return ErrEgressBlocked }
	resp, err := copyClient.Do(req)
	if err != nil {
		return "", 0, fmt.Errorf("%w: embedding response unavailable", ErrModelUnknownOutcome)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 429 {
		return "", 0, ErrModelRetryable
	}
	if resp.StatusCode >= 500 {
		return "", 0, ErrModelUnknownOutcome
	}
	if resp.StatusCode >= 400 {
		return "", 0, errors.New("flow: embedding gateway rejected request")
	}
	response, err := io.ReadAll(io.LimitReader(resp.Body, (4<<20)+1))
	if err != nil || len(response) > 4<<20 {
		return "", 0, ErrModelUnknownOutcome
	}
	var output struct {
		Model string `json:"model"`
		Data  []struct {
			Index  int       `json:"index"`
			Vector []float64 `json:"embedding"`
		} `json:"data"`
		Usage struct {
			PromptTokens int64 `json:"prompt_tokens"`
			TotalTokens  int64 `json:"total_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(response, &output) != nil || output.Model != g.EmbeddingModel || len(output.Data) != len(texts) || output.Usage.TotalTokens <= 0 || output.Usage.TotalTokens > math.MaxInt64/g.EmbeddingMicroPer1KTok {
		return "", 0, ErrModelUnknownOutcome
	}
	if sink := modelUsageFrom(ctx); sink != nil {
		sink.InputTokens = output.Usage.TotalTokens
		sink.OutputTokens = 0
	}
	var vectors []map[string]any
	seen := map[int]bool{}
	dims := g.EmbeddingDimensions
	for _, row := range output.Data {
		if row.Index < 0 || row.Index >= len(texts) || seen[row.Index] || len(row.Vector) == 0 || len(row.Vector) > 3072 {
			return "", 0, ErrModelUnknownOutcome
		}
		seen[row.Index] = true
		if dims == 0 {
			dims = len(row.Vector)
		}
		if len(row.Vector) != dims {
			return "", 0, ErrModelUnknownOutcome
		}
		nonzero := false
		for _, v := range row.Vector {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return "", 0, ErrModelUnknownOutcome
			}
			nonzero = nonzero || v != 0
		}
		if !nonzero {
			return "", 0, ErrModelUnknownOutcome
		}
		vectors = append(vectors, map[string]any{"chunk_id": texts[row.Index].ChunkID, "sha256": texts[row.Index].SHA256, "vector": row.Vector})
	}
	result, _ := json.Marshal(map[string]any{"model": g.EmbeddingModel, "dimensions": dims, "vectors": vectors})
	cost, err := canvasTokenCost(output.Usage.TotalTokens, g.EmbeddingMicroPer1KTok)
	return string(result), cost, err
}
