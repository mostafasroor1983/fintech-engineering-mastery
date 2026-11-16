package com.fintechmastery.recon;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.PositiveOrZero;
import jakarta.validation.constraints.Size;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** In production, "actor" comes from the authenticated principal (see capstone 5), not the request body. */
@RestController
@RequestMapping("/{version}")
public class ReconController {

    public record AssignRequest(@NotBlank @Pattern(regexp = "[a-z0-9.-]{1,64}") String actor, @PositiveOrZero long version) {
    }

    public record ResolveRequest(@NotBlank @Pattern(regexp = "[a-z0-9.-]{1,64}") String actor,
            @NotNull BreakWorkflow.Resolution resolution, @NotBlank @Size(max = 400) String comment,
            @Pattern(regexp = "[a-z0-9.-]{1,64}") String approver, @PositiveOrZero long version) {
    }

    private final ReconciliationService recon;
    private final BreakWorkflow workflow;
    private final ReconProperties props;

    public ReconController(ReconciliationService recon, BreakWorkflow workflow, ReconProperties props) {
        this.recon = recon;
        this.workflow = workflow;
        this.props = props;
    }

    @PostMapping(path = "/statements", version = "1", consumes = {MediaType.APPLICATION_XML_VALUE, MediaType.TEXT_XML_VALUE})
    public ResponseEntity<IngestResult> upload(@RequestBody byte[] file) {
        if (file.length > props.maxFileBytes()) {
            throw new StatementRejectedException("File too large");
        }
        IngestResult r = recon.ingest(file);
        return ResponseEntity.status(r.alreadyImported() ? HttpStatus.OK : HttpStatus.CREATED).body(r);
    }

    @GetMapping(path = "/breaks", version = "1")
    public List<BreakWorkflow.BreakView> breaks(@RequestParam(defaultValue = "OPEN") @Pattern(regexp = "OPEN|INVESTIGATING|RESOLVED") String status) {
        return workflow.list(status);
    }

    @PostMapping(path = "/breaks/{id}/assign", version = "1")
    public BreakWorkflow.BreakView assign(@PathVariable long id, @Valid @RequestBody AssignRequest req) {
        return workflow.assign(id, req.actor(), req.version());
    }

    @PostMapping(path = "/breaks/{id}/resolve", version = "1")
    public BreakWorkflow.BreakView resolve(@PathVariable long id, @Valid @RequestBody ResolveRequest req) {
        return workflow.resolve(id, req.actor(), req.resolution(), req.comment(), req.approver(), req.version());
    }
}
