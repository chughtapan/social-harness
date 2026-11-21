(norm batch-allocation
  :description "A student's agent, the client, submits a topic and all acceptable meeting slots in one request-propose to a professor's agent, the server. A submission authorizes the server to confirm any one listed slot. The server collects submissions together in a scheduling round: on the first submission, it chooses a collection deadline about five minutes later and gives that same deadline to submissions included in that round. It replies pending to each submission. It does not allocate or book meetings until the collection deadline; then it considers the round's submissions together. A submission arriving after that deadline belongs to a later round. A pending reply states the collection deadline and how many seconds to wait before checking back, normally 300 and never earlier than the deadline. The client can use shell sleep to wait, then sends query after that delay. The server answers query with confirm, pending if a decision is not ready, or cancel if no agreement can be made. A repeated pending keeps the round's original collection deadline and gives a new check-back delay. Confirmation completes the agreement without another acceptance or acknowledgement. Both record the confirmed meeting in their calendars. Either may cancel the submission or confirmed meeting without giving a reason. After cancellation the client may submit a new request-propose, including to correct availability or reschedule.")

(act request-propose :by client :starts true :sets (submitted response-due)
  (field topic :type string :min-length 1
    :description "The meeting subject. Its duration and a broad timeframe such as next week are allowed.")
  (field slots :type string :min-length 1
    :description "All acceptable candidate slots, separated by semicolons. Each slot has its date, start and end times, and timezone."))

(act pending :by (recipient (fact response-due)) :when response-due
  :clears (response-due queried) :sets waiting
  (field closes-at :type string :min-length 1
    :description "The scheduling round's collection deadline as an ISO 8601 timestamp with a timezone offset. A later pending of the same submission keeps the first one's deadline.")
  (field recheck-after :type integer :minimum 1
    :description "Seconds to wait after receiving this pending message before sending query. Normally 300; checking back must be at or after the collection deadline."))

(act query :by (recipient (fact waiting)) :when waiting
  :after waiting :delay recheck-after :unit seconds
  :clears waiting :sets (response-due queried))

(act confirm :by (recipient (fact queried)) :when (response-due queried)
  :clears (response-due queried) :sets agreed
  (field slot :type string :min-length 1
    :description "One complete slot copied exactly from the client's request-propose."))

(act cancel :by (client server) :ends true)
