(norm student-first
  :description "A student's agent, the client, sends request-propose with a topic and candidate meeting times in one message to a professor's agent, the server. The server confirms one offered time or rejects all. Only after rejection may the client send request-propose-alternatives with the topic and revised times. Either may cancel a pending or confirmed meeting without giving a reason. To reschedule a confirmed meeting, cancel it and send a new request-propose.")

(act request-propose :by client :starts true :sets offered
  (field topic :type string :min-length 1
    :description "The meeting subject. Its duration and a broad timeframe such as next week are allowed; candidate times belong in options.")
  (field options :type list :min-items 1 :max-items 3
    :description "One candidate meeting slot: a date, start and end times, and a timezone."))
(act request-propose-alternatives :by client :when alternatives-due
  :clears alternatives-due :sets offered
  (field topic :type string :min-length 1
    :description "The meeting subject. Its duration and a broad timeframe such as next week are allowed; candidate times belong in options.")
  (field options :type list :min-items 1 :max-items 3
    :description "One candidate meeting slot: a date, start and end times, and a timezone."))
(act reject-proposal :by server :when offered
  :clears offered :sets alternatives-due)
(act confirm :by server :when offered
  :clears offered :sets confirmed
  (field slot :type string :min-length 1
    :description "The agreed meeting slot, copied exactly from the offer.")
  (relation member slot (previous (fact offered) options)))
(act cancel :by (client server) :ends true)
