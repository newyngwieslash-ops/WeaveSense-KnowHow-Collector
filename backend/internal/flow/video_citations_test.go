package flow

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestVideoCitationTemporalProjectionAndIndependentOrigins(t *testing.T) {
	var evidence ResolvedEvidence
	raw := `{"evidence_id":"ev-video","document_id":"doc","source_id":"bili","revision":3,"snippet_hash":"hash","quote":"中文😀","start_ms":0,"end_ms":1200,"alignment_method":"segment","frame_ref":"frame-1","media_sha256":"media","material_type":"asr_transcript","origin_cluster":"origin-one","offset_unit":"utf16","availability":"media_expired"}`
	if json.Unmarshal([]byte(raw), &evidence) != nil || evidence.StartMS == nil || *evidence.StartMS != 0 || evidence.EndMS == nil || *evidence.EndMS != 1200 || evidence.AlignmentMethod != "segment" {
		t.Fatal("lost temporal origin or zero timestamp")
	}
	projected, _ := json.Marshal(evidence)
	for _, field := range []string{"origin_cluster", "offset_unit", "media_expired", "start_ms", "frame_ref"} {
		if !strings.Contains(string(projected), field) {
			t.Fatalf("projection lost %s", field)
		}
	}
	repost := evidence
	repost.EvidenceID = "ev-repost"
	repost.SourceID = "douyin"
	claims := []ReportClaim{{Text: "Two platforms repeat the same source.", Kind: "cross_source_verified", Citations: []Citation{{EvidenceID: evidence.EvidenceID, Revision: 3}, {EvidenceID: repost.EvidenceID, Revision: 3}}}}
	if _, err := ValidateCitations(claims, MaterialScope{DocumentIDs: []string{"doc"}}, []ResolvedEvidence{evidence, repost}); err == nil {
		t.Fatal("reposted source counted as independent corroboration")
	}
	repost.OriginCluster = "independent"
	if _, err := ValidateCitations(claims, MaterialScope{DocumentIDs: []string{"doc"}}, []ResolvedEvidence{evidence, repost}); err != nil {
		t.Fatal(err)
	}
	evidence.MaterialType = "derived_summary"
	if _, err := ValidateCitations([]ReportClaim{{Text: "Summary is not original evidence.", Kind: "source_statement", Citations: []Citation{{EvidenceID: evidence.EvidenceID, Revision: 3}}}}, MaterialScope{DocumentIDs: []string{"doc"}}, []ResolvedEvidence{evidence}); err == nil {
		t.Fatal("model summary cited as original source")
	}
}
